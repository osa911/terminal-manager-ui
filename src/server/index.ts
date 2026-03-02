import express from 'express';
import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { Session, ClientMessage, ServerMessage, ChatMessage } from './types';
import { discoverSessions } from './session-discovery';
import { sendInput as itermSendInput, sendInputByTty } from './iterm-bridge';
import { JsonlWatcher } from './jsonl-watcher';
import { AttentionDetector } from './attention-detector';
import { PtyManager } from './pty-manager';

const PORT = 3456;
const DISCOVERY_INTERVAL = 15000; // Session discovery only (new/dead processes); status is event-driven
const NAMES_FILE = path.join(__dirname, '..', '..', 'session-names.json');
const SHARES_FILE = path.join(__dirname, '..', '..', 'share-tokens.json');
const AUTH_PASSWORD = process.env.TM_PASSWORD || 'admin';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'dist', 'public');

// Valid auth sessions (token → expiry timestamp)
const authSessions = new Map<string, number>();
const AUTH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Share tokens for external sharing (persisted)
const shareTokens = new Map<string, { sessionId: string; interactive: boolean }>();

// ── Custom session names (persisted) ──
// Keyed by claudeSessionId so names survive pid/id changes across restarts
let sessionNames: Record<string, string> = {};

function loadSessionNames(): void {
  try {
    if (fs.existsSync(NAMES_FILE)) {
      sessionNames = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf-8'));
    }
  } catch {
    sessionNames = {};
  }
}

function saveSessionNames(): void {
  try {
    fs.writeFileSync(NAMES_FILE, JSON.stringify(sessionNames, null, 2));
  } catch (err) {
    console.error('Failed to save session names:', err);
  }
}

function applyCustomNames(sessionList: Session[]): void {
  for (const s of sessionList) {
    const key = s.claudeSessionId || s.id;
    if (sessionNames[key]) {
      s.customName = sessionNames[key];
    }
  }
}

loadSessionNames();

function loadShareTokens(): void {
  try {
    if (fs.existsSync(SHARES_FILE)) {
      const data = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf-8'));
      for (const [token, info] of Object.entries(data)) {
        shareTokens.set(token, info as { sessionId: string; interactive: boolean });
      }
    }
  } catch {
    // Ignore
  }
}

function saveShareTokens(): void {
  try {
    const obj: Record<string, { sessionId: string; interactive: boolean }> = {};
    for (const [token, info] of shareTokens) {
      obj[token] = info;
    }
    fs.writeFileSync(SHARES_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Failed to save share tokens:', err);
  }
}

loadShareTokens();

// ── State ──
let sessions: Session[] = [];
const subscriptions = new Map<WebSocket, string>(); // ws → sessionId
const sharedClients = new Map<WebSocket, { sessionId: string; interactive: boolean }>();

// ── Init modules ──
const jsonlWatcher = new JsonlWatcher();
const attentionDetector = new AttentionDetector();
const ptyManager = new PtyManager();

// ── Auth helpers ──
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k] = v.join('=');
  }
  return cookies;
}

function isAuthenticated(req: express.Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['tm_auth'];
  if (!token) return false;
  const expiry = authSessions.get(token);
  if (!expiry || Date.now() > expiry) {
    authSessions.delete(token);
    return false;
  }
  return true;
}

function isWsAuthenticated(req: http.IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['tm_auth'];
  if (!token) return false;
  const expiry = authSessions.get(token);
  if (!expiry || Date.now() > expiry) {
    authSessions.delete(token);
    return false;
  }
  return true;
}

// ── Express ──
const app = express();
app.use(express.json());

// Auth endpoints (no auth required)
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== AUTH_PASSWORD) {
    res.status(401).json({ error: 'Wrong password' });
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, Date.now() + AUTH_MAX_AGE);
  res.setHeader('Set-Cookie', `tm_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_MAX_AGE / 1000}`);
  res.json({ ok: true });
});

app.get('/api/auth-check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// Share routes skip auth (share token is its own auth)
app.get('/share/:token', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/api/share/:token', (req, res) => {
  const info = shareTokens.get(req.params.token);
  if (!info) {
    res.status(404).json({ error: 'Share not found' });
    return;
  }
  res.json(info);
});

// Login page
app.get('/login', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// Everything else requires auth
app.use((req, res, next) => {
  // Static assets always allowed
  if (req.path.match(/\.(js|css|ico|png|svg)$/)) return next();
  if (isAuthenticated(req)) return next();
  res.redirect('/login');
});

app.use(express.static(PUBLIC_DIR));

// Serve index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// API: Create share token (requires auth via middleware)
app.post('/api/share', (req, res) => {
  const { sessionId, interactive } = req.body;
  const token = Math.random().toString(36).slice(2, 14);
  shareTokens.set(token, { sessionId, interactive: !!interactive });
  saveShareTokens();
  res.json({ token, url: `/share/${token}` });
});

// API: List directories for folder browser
app.get('/api/directories', (req, res) => {
  const requestedPath = (req.query.path as string) || process.env.HOME || '/';
  const resolved = path.resolve(requestedPath.replace(/^~/, process.env.HOME || '/'));

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Check if this directory has a .git folder (is a project)
    const hasGit = entries.some(e => e.name === '.git' && e.isDirectory());

    res.json({ path: resolved, dirs, hasGit });
  } catch {
    res.status(400).json({ error: 'Cannot read directory' });
  }
});

// ── HTTP Server ──
const server = http.createServer(app);

// ── WebSocket ──
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // Shared clients only get their subscribed session (not the full list)
    if (msg.type === 'sessions-update' && sharedClients.has(client)) {
      const subId = subscriptions.get(client);
      if (subId) {
        const filtered = msg.sessions.filter(s => s.id === subId);
        sendTo(client, { type: 'sessions-update', sessions: filtered });
      }
      continue;
    }
    client.send(data);
  }
}

function sendTo(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws, req) => {
  // Check if this is a shared connection via ?share=<token> query param
  const parsed = url.parse(req.url || '', true);
  const shareParam = parsed.query.share as string | undefined;

  if (shareParam) {
    const shareInfo = shareTokens.get(shareParam);
    if (shareInfo) {
      sharedClients.set(ws, shareInfo);
    }
  }

  const isShared = sharedClients.has(ws);
  const isAuthed = isShared || isWsAuthenticated(req);

  if (!isAuthed) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const canEdit = isShared ? (sharedClients.get(ws)?.interactive ?? false) : true;

  // Tell the client what access level they have
  sendTo(ws, { type: 'access-level', canEdit, isShared } as any);

  // Only send full session list to non-shared clients
  if (!isShared) {
    sendTo(ws, { type: 'sessions-update', sessions });
  }

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;
      await handleClientMessage(ws, msg);
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    subscriptions.delete(ws);
    sharedClients.delete(ws);
  });
});

function canWrite(ws: WebSocket): boolean {
  // Shared clients: only if interactive
  if (sharedClients.has(ws)) {
    return sharedClients.get(ws)!.interactive;
  }
  // Non-shared clients: full access
  return true;
}

async function handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'subscribe': {
      subscriptions.set(ws, msg.sessionId);
      const session = findSession(msg.sessionId);
      if (session?.jsonlPath) {
        const messages = jsonlWatcher.readFullConversation(session.jsonlPath);
        sendTo(ws, { type: 'chat-messages', sessionId: msg.sessionId, messages });
      }
      break;
    }

    case 'send-input': {
      if (!canWrite(ws)) break;
      const session = findSession(msg.sessionId);
      if (!session) break;

      if (session.type === 'spawned') {
        ptyManager.sendInput(msg.sessionId, msg.text);
      } else if (session.itermSessionId) {
        await itermSendInput(session.itermSessionId, msg.text);
      } else if (session.tty) {
        const sent = await sendInputByTty(session.tty, msg.text);
        if (!sent) {
          console.warn(`Failed to send input for TTY ${session.tty}`);
        }
      }

      // Clear attention status after input
      if (session.status === 'attention') {
        session.status = 'active';
        session.attentionReason = undefined;
        broadcast({ type: 'sessions-update', sessions });
      }
      break;
    }

    case 'create-session': {
      console.log('create-session received, cwd:', msg.cwd, 'canWrite:', canWrite(ws));
      if (!canWrite(ws)) break;
      try {
        const session = ptyManager.createSession(msg.cwd);
        console.log('Session created:', session.id, 'pid:', session.pid);
        sessions.push(session);
        broadcast({ type: 'sessions-update', sessions });
      } catch (err) {
        console.error('Failed to create session:', err);
      }
      break;
    }

    case 'resize': {
      ptyManager.resize(msg.sessionId, msg.cols, msg.rows);
      break;
    }

    case 'resume-session': {
      if (!canWrite(ws)) break;
      const terminated = findSession(msg.sessionId);
      if (!terminated || !terminated.claudeSessionId) break;

      const cwd = terminated.cwd || process.env.HOME || '/tmp';
      const resumed = ptyManager.resumeSession(
        terminated.claudeSessionId,
        cwd,
        msg.sessionId,
      );
      sessions.push(resumed);

      // Auto-subscribe the client to the new session
      subscriptions.set(ws, resumed.id);

      broadcast({ type: 'sessions-update', sessions });
      break;
    }

    case 'terminate-session': {
      if (!canWrite(ws)) break;
      const session = findSession(msg.sessionId);
      if (!session) break;

      if (session.type === 'spawned') {
        // Kill the PTY process we own
        ptyManager.killSession(msg.sessionId);
      } else if (session.pid) {
        // Send SIGTERM to discovered process
        try {
          process.kill(session.pid, 'SIGTERM');
        } catch {
          // Process may already be dead
        }
      }

      session.status = 'dead';
      broadcast({ type: 'sessions-update', sessions });
      break;
    }

    case 'rename-session': {
      if (!canWrite(ws)) break;
      const session = findSession(msg.sessionId);
      if (!session) break;

      const name = msg.name.trim();
      const key = session.claudeSessionId || session.id;

      if (name) {
        sessionNames[key] = name;
        session.customName = name;
      } else {
        delete sessionNames[key];
        session.customName = undefined;
      }

      saveSessionNames();
      broadcast({ type: 'sessions-update', sessions });
      break;
    }
  }
}

function findSession(id: string): Session | undefined {
  return sessions.find(s => s.id === id);
}

// ── PTY events ──
ptyManager.on('data', (sessionId: string, data: string) => {
  for (const [ws, subId] of subscriptions) {
    if (subId === sessionId) {
      sendTo(ws, { type: 'pty-data', sessionId, data });
    }
  }
});

ptyManager.on('exit', (sessionId: string, _exitCode: number) => {
  const session = findSession(sessionId);
  if (session) {
    session.status = 'dead';
    broadcast({ type: 'sessions-update', sessions });
  }
});

// When a resumed session replaces a terminated one, update subscriptions
ptyManager.on('session-replaced', (oldSessionId: string, newSessionId: string) => {
  for (const [ws, subId] of subscriptions) {
    if (subId === oldSessionId) {
      subscriptions.set(ws, newSessionId);
    }
  }
});

// ── JSONL watcher events ──
jsonlWatcher.on('message', (filePath: string, message: ChatMessage) => {
  // Find which session this file belongs to
  const session = sessions.find(s => s.jsonlPath === filePath);
  if (!session) return;

  // If the message is an AskUserQuestion, mark session as needing attention
  if (message.type === 'question') {
    session.status = 'attention';
    session.attentionReason = 'Question prompt';
    broadcast({ type: 'sessions-update', sessions });
    broadcast({ type: 'attention-needed', sessionId: session.id, reason: 'Question prompt' });
  }

  for (const [ws, subId] of subscriptions) {
    if (subId === session.id) {
      sendTo(ws, { type: 'chat-message-append', sessionId: session.id, message });
    }
  }
});

// ── Attention events ──
attentionDetector.on('attention-needed', (sessionId: string, reason: string) => {
  broadcast({ type: 'attention-needed', sessionId, reason });
});

attentionDetector.on('status-changed', () => {
  broadcast({ type: 'sessions-update', sessions });
});

// ── Discovery loop ──
async function refreshSessions(): Promise<void> {
  try {
    const discovered = await discoverSessions(jsonlWatcher);
    const spawned = ptyManager.getAllSessions();

    // Merge discovered + spawned, preserving attention state
    const merged: Session[] = [];

    for (const d of discovered) {
      const existing = sessions.find(s => s.id === d.id);
      if (existing) {
        // Preserve status set by AttentionDetector (active/attention/idle)
        // Discovery always defaults to 'idle', so carry over detector's verdict
        d.status = existing.status;
        d.attentionReason = existing.attentionReason;
      }
      merged.push(d);
    }

    for (const s of spawned) {
      merged.push(s);
    }

    sessions = merged;
    applyCustomNames(sessions);
    broadcast({ type: 'sessions-update', sessions });
  } catch (err) {
    console.error('Session discovery error:', err);
  }
}

// ── Start ──
server.listen(PORT, () => {
  console.log(`Terminal Manager running at http://localhost:${PORT}`);

  jsonlWatcher.start();
  attentionDetector.start(() => sessions, jsonlWatcher);

  // Initial discovery
  refreshSessions();

  // Periodic refresh
  setInterval(refreshSessions, DISCOVERY_INTERVAL);
});

// ── Graceful shutdown ──
function shutdown(): void {
  console.log('\nShutting down...');
  attentionDetector.stop();
  jsonlWatcher.stop();
  ptyManager.destroy();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
