import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Session, ITermSession, JsonlEntry, JsonlContentBlock } from './types';
import { enumerateSessions } from './iterm-bridge';
import { JsonlWatcher } from './jsonl-watcher';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

interface ProcessInfo {
  pid: number;
  tty: string;
  args: string;
  startTime: string;
}

function findClaudeProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    // Use -eo for precise column parsing: pid, tty, args
    execFile('ps', ['-eo', 'pid,tty,args'], (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }

      const processes: ProcessInfo[] = [];
      const lines = stdout.split('\n').slice(1); // skip header

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse: PID TTY ARGS
        const match = trimmed.match(/^(\d+)\s+([\w/]+|\?\?)\s+(.+)$/);
        if (!match) continue;

        const pid = parseInt(match[1], 10);
        const tty = match[2];
        const args = match[3];

        // Only match "claude" CLI processes:
        // - Must be on a real TTY (not "??" which are background/subagent processes)
        // - Must be the claude binary directly (not Claude.app, not shell scripts)
        // - Exclude our own server
        if (tty === '??' || tty === '-') continue;
        if (args.includes('terminal-manager')) continue;
        if (args.includes('Claude.app')) continue;

        // Match: "claude", "claude --resume ...", "/path/to/claude ..."
        const isClaudeCli = /^(claude(\s|$)|.*\/claude(\s|$))/.test(args);
        if (!isClaudeCli) continue;

        processes.push({ pid, tty, args, startTime: '' });
      }

      resolve(processes);
    });
  });
}

interface PidInfo {
  cwd: string | null;
  claudeSessionId: string | null;
}

function getProcessInfo(pid: number): Promise<PidInfo> {
  return new Promise((resolve) => {
    execFile('lsof', ['-p', pid.toString(), '-Fn'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ cwd: null, claudeSessionId: null });
        return;
      }

      let cwd: string | null = null;
      let claudeSessionId: string | null = null;
      const lines = stdout.split('\n');

      for (let i = 0; i < lines.length; i++) {
        // Extract cwd
        if (lines[i] === 'fcwd' && i + 1 < lines.length && lines[i + 1].startsWith('n')) {
          cwd = lines[i + 1].slice(1);
        }
        // Extract session ID from open .claude/tasks/<uuid> directory
        if (lines[i].startsWith('n')) {
          const taskMatch = lines[i].match(/\.claude\/tasks\/([0-9a-f-]{36})/);
          if (taskMatch) {
            claudeSessionId = taskMatch[1];
          }
        }
      }

      resolve({ cwd, claudeSessionId });
    });
  });
}

function extractProjectName(cwd: string): string {
  return path.basename(cwd);
}

function extractBranch(cwd: string): string | null {
  try {
    const gitPath = path.join(cwd, '.git');
    let headPath: string;

    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: /path/to/.git/worktrees/<name>"
      const gitFileContent = fs.readFileSync(gitPath, 'utf-8').trim();
      const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+)/);
      if (!gitdirMatch) return null;
      headPath = path.join(gitdirMatch[1], 'HEAD');
    } else {
      headPath = path.join(gitPath, 'HEAD');
    }

    const content = fs.readFileSync(headPath, 'utf-8').trim();
    if (content.startsWith('ref: refs/heads/')) {
      return content.replace('ref: refs/heads/', '');
    }
    return content.slice(0, 8); // Short hash for detached HEAD
  } catch {
    return null;
  }
}

function matchTtyToIterm(
  processTty: string,
  itermSessions: ITermSession[]
): ITermSession | undefined {
  if (!processTty || processTty === '??') return undefined;

  // ps -eo tty shows "ttys000", iTerm2 shows "/dev/ttys000"
  const normalizedTty = processTty.startsWith('/dev/')
    ? processTty
    : `/dev/${processTty}`;

  return itermSessions.find(s => s.tty === normalizedTty);
}

/**
 * Extract a short summary from JSONL by finding the first user message text.
 */
function extractSessionSummary(jsonlPath: string): { summary: string; cwd?: string; branch?: string; sessionId?: string; startedAt?: number; lastActivity?: number } {
  const result: { summary: string; cwd?: string; branch?: string; sessionId?: string; startedAt?: number; lastActivity?: number } = { summary: '' };

  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let firstTimestamp: number | undefined;
    let lastTimestamp: number | undefined;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;

        // Track timestamps
        if (entry.timestamp) {
          const ts = new Date(entry.timestamp).getTime();
          if (!firstTimestamp) firstTimestamp = ts;
          lastTimestamp = ts;
        }

        // Extract metadata from first entry
        if (!result.sessionId && entry.sessionId) {
          result.sessionId = entry.sessionId;
        }
        if (!result.cwd && entry.cwd) {
          result.cwd = entry.cwd;
        }
        if (!result.branch && entry.gitBranch) {
          result.branch = entry.gitBranch;
        }

        // Extract first user message as summary
        if (!result.summary && entry.type === 'user' && entry.message?.content) {
          const content = entry.message.content;
          if (typeof content === 'string') {
            result.summary = content.slice(0, 120);
          } else if (Array.isArray(content)) {
            const textBlock = (content as JsonlContentBlock[]).find(b => b.type === 'text' && b.text);
            if (textBlock?.text) {
              result.summary = textBlock.text.slice(0, 120);
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    result.startedAt = firstTimestamp;
    result.lastActivity = lastTimestamp;
  } catch {
    // File not readable
  }

  return result;
}

/**
 * Decode a Claude project directory name back to a filesystem path.
 * e.g. "-Users-john-Documents-myproject" → "/Users/john/Documents/myproject"
 */
function decodeProjectPath(dirname: string): string {
  // Replace leading dash with / and all other dashes with /
  return dirname.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Discover terminated/past sessions from JSONL files in ~/.claude/projects/.
 * Returns sessions from the last 3 days that are not currently running.
 */
function discoverTerminatedSessions(runningSessionIds: Set<string>): Session[] {
  const claudeDir = path.join(process.env.HOME || '~', '.claude', 'projects');
  const sessions: Session[] = [];
  const now = Date.now();

  try {
    if (!fs.existsSync(claudeDir)) return sessions;

    const projectDirs = fs.readdirSync(claudeDir);
    for (const dir of projectDirs) {
      const dirPath = path.join(claudeDir, dir);
      try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) continue;

        // Find all JSONL files in this project directory
        const files = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fullPath = path.join(dirPath, f);
            const fileStat = fs.statSync(fullPath);
            return {
              name: f,
              path: fullPath,
              sessionId: path.basename(f, '.jsonl'),
              mtime: fileStat.mtimeMs,
              size: fileStat.size,
            };
          })
          .filter(f => now - f.mtime < THREE_DAYS_MS && f.size > 100) // Recent + non-empty
          .sort((a, b) => b.mtime - a.mtime);

        for (const file of files) {
          // Skip sessions that are currently running
          if (runningSessionIds.has(file.sessionId)) continue;

          const info = extractSessionSummary(file.path);
          const projectPath = decodeProjectPath(dir);

          sessions.push({
            id: `terminated-${file.sessionId}`,
            type: 'terminated',
            cwd: info.cwd || projectPath,
            projectName: extractProjectName(info.cwd || projectPath),
            branch: info.branch || undefined,
            jsonlPath: file.path,
            claudeSessionId: info.sessionId || file.sessionId,
            status: 'terminated',
            lastActivity: info.lastActivity || file.mtime,
            startedAt: info.startedAt,
            summary: info.summary || undefined,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Ignore
  }

  // Sort by last activity (most recent first)
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);

  return sessions;
}

export async function discoverSessions(jsonlWatcher: JsonlWatcher): Promise<Session[]> {
  const [processes, itermSessions] = await Promise.all([
    findClaudeProcesses(),
    enumerateSessions(),
  ]);

  const activeSessions: Session[] = [];
  const runningSessionIds = new Set<string>();
  // Track which claudeSessionIds we've already added to deduplicate
  const seenClaudeSessionIds = new Set<string>();

  // First pass: gather process info for all processes in parallel
  const processInfos = await Promise.all(
    processes.map(async (proc) => ({
      proc,
      info: await getProcessInfo(proc.pid),
    }))
  );

  // Sort so processes WITH a session ID come first (they have definitive mapping).
  // Among those, prefer lower PID (typically the main process).
  processInfos.sort((a, b) => {
    const aHasId = a.info.claudeSessionId ? 0 : 1;
    const bHasId = b.info.claudeSessionId ? 0 : 1;
    if (aHasId !== bHasId) return aHasId - bHasId;
    return a.proc.pid - b.proc.pid;
  });

  for (const { proc, info } of processInfos) {
    const cwd = info.cwd;
    const itermSession = matchTtyToIterm(proc.tty, itermSessions);

    // Find JSONL by exact session ID (from lsof .claude/tasks/<uuid>)
    let jsonlPath: string | null = null;
    let claudeSessionId = info.claudeSessionId || undefined;

    if (claudeSessionId && cwd) {
      const encodedCwd = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
      const candidate = path.join(
        process.env.HOME || '~', '.claude', 'projects', encodedCwd,
        claudeSessionId + '.jsonl',
      );
      if (fs.existsSync(candidate)) {
        jsonlPath = candidate;
      }
    }

    // Fallback: find most recent JSONL for this project
    if (!jsonlPath && cwd) {
      jsonlPath = jsonlWatcher.findSessionFile(cwd);
      if (jsonlPath && !claudeSessionId) {
        claudeSessionId = path.basename(jsonlPath, '.jsonl');
      }
    }

    // Deduplicate: skip if we already have a session with this claudeSessionId.
    // This handles two cases:
    // 1. Process without a session ID that falls back to another process's JSONL
    // 2. Multiple processes sharing the same claudeSessionId (parent/child)
    if (claudeSessionId) {
      if (seenClaudeSessionIds.has(claudeSessionId)) {
        continue;
      }
      seenClaudeSessionIds.add(claudeSessionId);
      runningSessionIds.add(claudeSessionId);
    }

    // Get branch and summary from this session's JSONL
    let branch = cwd ? extractBranch(cwd) || undefined : undefined;
    let summary: string | undefined;
    if (jsonlPath) {
      const meta = extractSessionSummary(jsonlPath);
      if (meta.branch) branch = meta.branch;
      summary = meta.summary || undefined;
    }

    // Status will be set by AttentionDetector (reads terminal content).
    // Default to idle; the detector updates to active/attention as needed.
    const session: Session = {
      id: itermSession?.id || `pid-${proc.pid}`,
      type: 'discovered',
      pid: proc.pid,
      tty: proc.tty,
      cwd: cwd || undefined,
      projectName: cwd ? extractProjectName(cwd) : undefined,
      branch,
      summary,
      itermSessionId: itermSession?.id,
      jsonlPath: jsonlPath || undefined,
      claudeSessionId,
      status: 'idle',
      lastActivity: Date.now(),
    };

    activeSessions.push(session);
  }

  // Discover terminated sessions from JSONL files
  const terminatedSessions = discoverTerminatedSessions(runningSessionIds);

  return [...activeSessions, ...terminatedSessions];
}
