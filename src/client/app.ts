import { ChatView, ChatMessage, setOnAnswerCallback } from './chat-view';
import { TerminalView } from './terminal-view';

// ── Types (mirror server types) ──
interface Session {
  id: string;
  type: 'discovered' | 'spawned' | 'terminated';
  pid?: number;
  tty?: string;
  cwd?: string;
  projectName?: string;
  branch?: string;
  itermSessionId?: string;
  jsonlPath?: string;
  claudeSessionId?: string;
  status: 'active' | 'idle' | 'attention' | 'dead' | 'terminated';
  attentionReason?: string;
  lastActivity: number;
  startedAt?: number;
  summary?: string;
  customName?: string;
}

type ServerMessage =
  | { type: 'sessions-update'; sessions: Session[] }
  | { type: 'terminal-content'; sessionId: string; content: string }
  | { type: 'chat-messages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'chat-message-append'; sessionId: string; message: ChatMessage }
  | { type: 'attention-needed'; sessionId: string; reason: string }
  | { type: 'pty-data'; sessionId: string; data: string };

// ── State ──
let ws: WebSocket | null = null;
let sessions: Session[] = [];
let selectedSessionId: string | null = null;
let searchQuery = '';
let isSharedView = false;
let shareToken: string | null = null;
let isEditMode = false;

// ── Views ──
const chatView = new ChatView('chat-messages');
const terminalView = new TerminalView('terminal-container');

// ── DOM references ──
const $ = (id: string) => document.getElementById(id)!;
const sessionList = $('session-list');
const sessionCount = $('session-count');
const emptyState = $('empty-state');
const sessionView = $('session-view');
const sessionTitle = $('session-title');
const sessionBranch = $('session-branch');
const sessionStatusBadge = $('session-status-badge');
const inputText = $('input-text') as HTMLTextAreaElement;
const quickActions = $('quick-actions');
const connectionStatus = $('connection-status');
const connectionText = $('connection-text');

// ── WebSocket ──
function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = shareToken ? `?share=${shareToken}` : '';
  ws = new WebSocket(`${protocol}//${location.host}${params}`);

  ws.onopen = () => {
    connectionStatus.className = 'status-dot status-connected';
    connectionText.textContent = 'Connected';

    // Re-subscribe to selected session
    if (selectedSessionId) {
      send({ type: 'subscribe', sessionId: selectedSessionId });
    }
  };

  ws.onclose = () => {
    connectionStatus.className = 'status-dot status-disconnected';
    connectionText.textContent = 'Disconnected';
    // Auto-reconnect
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data) as ServerMessage;
    handleServerMessage(msg);
  };
}

function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Message handlers ──
function applyEditMode(): void {
  const btnNew = $('btn-new-session') as HTMLButtonElement;
  const btnSend = $('btn-send') as HTMLButtonElement;

  btnNew.disabled = !isEditMode;
  btnSend.disabled = !isEditMode;
  inputText.disabled = !isEditMode;
  inputText.placeholder = isEditMode ? 'Type a message... (Shift+Enter for new line)' : 'Read-only mode';

  // Re-render current session header to update button states
  updateSessionHeader();
}

function handleServerMessage(msg: ServerMessage | { type: 'access-level'; canEdit: boolean; isShared: boolean }): void {
  switch (msg.type) {
    case 'access-level':
      isEditMode = msg.canEdit;
      applyEditMode();
      break;
    case 'sessions-update': {
      // If we were viewing a terminated session that just got resumed,
      // switch to the new spawned session
      const prev = selectedSessionId;
      sessions = msg.sessions;

      if (prev && !sessions.find(s => s.id === prev)) {
        // Our selected session was replaced — find the resumed one
        const resumed = sessions.find(s => s.type === 'spawned' && s.status === 'active');
        if (resumed) {
          selectSession(resumed.id);
        }
      }

      // Restore session from URL hash on first load
      if (!selectedSessionId) {
        const hashMatch = location.hash.match(/^#session=(.+)/);
        if (hashMatch) {
          const target = sessions.find(s => s.id === hashMatch[1]);
          if (target) {
            selectSession(target.id);
          }
        }
      }

      renderSessionList();
      updateSessionHeader();
      break;
    }

    case 'chat-messages':
      if (msg.sessionId === selectedSessionId) {
        chatView.setMessages(msg.messages);
      }
      break;

    case 'chat-message-append':
      if (msg.sessionId === selectedSessionId) {
        chatView.appendMessage(msg.message);
      }
      break;

    case 'pty-data':
      if (msg.sessionId === selectedSessionId) {
        terminalView.write(msg.data);
      }
      break;

    case 'attention-needed':
      handleAttention(msg.sessionId, msg.reason);
      break;
  }
}

function handleAttention(sessionId: string, reason: string): void {
  // Update session status
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.status = 'attention';
    session.attentionReason = reason;
    renderSessionList();
  }

  // Show quick actions if this is the selected session
  if (sessionId === selectedSessionId) {
    quickActions.classList.remove('hidden');
  }

  // Browser notification
  if (Notification.permission === 'granted') {
    const name = session?.projectName || 'Unknown';
    new Notification(`Claude needs attention: ${name}`, { body: reason });
  }
}

// ── Rendering ──
function matchesSearch(session: Session, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [
    session.projectName,
    session.branch,
    session.cwd,
    session.summary,
    session.claudeSessionId,
  ].some(field => field?.toLowerCase().includes(q));
}

function getDateLabel(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const sessionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (sessionDay.getTime() === today.getTime()) return 'Today';
  if (sessionDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function groupByDate(items: Session[]): Map<string, Session[]> {
  const groups = new Map<string, Session[]>();
  for (const s of items) {
    const label = getDateLabel(s.lastActivity);
    const list = groups.get(label) || [];
    list.push(s);
    groups.set(label, list);
  }
  return groups;
}

function renderSessionList(): void {
  const filtered = sessions.filter(s => matchesSearch(s, searchQuery));
  const activeSessions = filtered.filter(s => s.type !== 'terminated');
  const terminatedSessions = filtered.filter(s => s.type === 'terminated');

  sessionCount.textContent = `${filtered.length}`;

  // Sort active: attention first, then active, then idle, then dead
  const statusOrder: Record<string, number> = { attention: 0, active: 1, idle: 2, dead: 3, terminated: 4 };
  const sortedActive = [...activeSessions].sort((a, b) => {
    const orderDiff = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2);
    if (orderDiff !== 0) return orderDiff;
    return b.lastActivity - a.lastActivity;
  });

  // Sort terminated by last activity (most recent first)
  const sortedTerminated = [...terminatedSessions].sort((a, b) => b.lastActivity - a.lastActivity);

  sessionList.innerHTML = '';

  // Active sessions section (grouped by date)
  if (sortedActive.length > 0) {
    const header = document.createElement('div');
    header.className = 'session-section-header';
    header.textContent = `Active (${sortedActive.length})`;
    sessionList.appendChild(header);

    const dateGroups = groupByDate(sortedActive);
    for (const [dateLabel, items] of dateGroups) {
      const dh = document.createElement('div');
      dh.className = 'session-date-header';
      dh.textContent = dateLabel;
      sessionList.appendChild(dh);
      for (const session of items) {
        sessionList.appendChild(renderSessionItem(session));
      }
    }
  }

  // Terminated sessions section (grouped by date)
  if (sortedTerminated.length > 0) {
    const header = document.createElement('div');
    header.className = 'session-section-header';
    header.textContent = `Recent (${sortedTerminated.length})`;
    sessionList.appendChild(header);

    const dateGroups = groupByDate(sortedTerminated);
    for (const [dateLabel, items] of dateGroups) {
      const dh = document.createElement('div');
      dh.className = 'session-date-header';
      dh.textContent = dateLabel;
      sessionList.appendChild(dh);
      for (const session of items) {
        sessionList.appendChild(renderSessionItem(session));
      }
    }
  }

  // Empty search state
  if (filtered.length === 0 && searchQuery) {
    const empty = document.createElement('div');
    empty.className = 'session-search-empty';
    empty.textContent = `No sessions matching "${searchQuery}"`;
    sessionList.appendChild(empty);
  }
}

function renderSessionItem(session: Session): HTMLElement {
  const item = document.createElement('div');
  item.className = `session-item${session.id === selectedSessionId ? ' active' : ''}`;
  item.dataset.sessionId = session.id;

  const name = session.customName || session.projectName || session.cwd || `Session ${session.id.slice(0, 8)}`;
  const detail = session.branch
    ? session.branch + (session.summary ? ' — ' + truncate(session.summary, 40) : '')
    : session.summary
      ? truncate(session.summary, 50)
      : (session.cwd || '');
  const timeAgo = formatTimeAgo(session.lastActivity);

  const dotClass = session.type === 'terminated' ? 'terminated' : session.status;

  item.innerHTML = `
    <div class="session-dot ${dotClass}"></div>
    <div class="session-meta">
      <div class="session-name">${escapeHtml(name)}</div>
      <div class="session-detail" title="${escapeHtml(session.summary || session.branch || session.cwd || '')}">${escapeHtml(detail)}</div>
      ${session.branch ? `<div class="session-branch-tag">${escapeHtml(session.branch)}</div>` : ''}
    </div>
    <div class="session-time">${timeAgo}</div>
  `;

  item.addEventListener('click', () => selectSession(session.id));
  return item;
}

function updateSessionHeader(): void {
  if (!selectedSessionId) return;
  const session = sessions.find(s => s.id === selectedSessionId);
  if (!session) return;

  sessionTitle.textContent = session.customName || session.projectName || `Session ${session.id.slice(0, 8)}`;

  if (session.branch) {
    sessionBranch.textContent = session.branch;
    sessionBranch.classList.remove('hidden');
  } else {
    sessionBranch.classList.add('hidden');
  }

  sessionStatusBadge.textContent = session.status;
  sessionStatusBadge.style.background = getStatusColor(session.status);
  sessionStatusBadge.style.color = '#fff';

  // Show/hide resume button (hidden in share view)
  const btnResume = $('btn-resume') as HTMLButtonElement;
  if (!isSharedView && session.type === 'terminated' && session.claudeSessionId) {
    btnResume.classList.remove('hidden');
    btnResume.disabled = !isEditMode;
  } else {
    btnResume.classList.add('hidden');
  }

  // Show/hide terminate button (hidden in share view)
  const btnTerminate = $('btn-terminate') as HTMLButtonElement;
  const isRunning = session.type === 'discovered' || session.type === 'spawned';
  const isAlive = session.status !== 'dead' && session.status !== 'terminated';
  if (!isSharedView && isRunning && isAlive) {
    btnTerminate.classList.remove('hidden');
    btnTerminate.disabled = !isEditMode;
  } else {
    btnTerminate.classList.add('hidden');
  }

  // Show/hide quick actions based on attention reason
  if (session.status === 'attention' && session.attentionReason) {
    const buttons = getQuickActionsForReason(session.attentionReason);
    if (buttons.length > 0) {
      quickActions.innerHTML = buttons
        .map(label => `<button class="btn btn-quick" data-action="${escapeHtml(label)}"${isEditMode ? '' : ' disabled'}>${escapeHtml(label)}</button>`)
        .join('');
      if (isEditMode) {
        quickActions.querySelectorAll('.btn-quick').forEach(btn => {
          btn.addEventListener('click', () => {
            const action = (btn as HTMLElement).dataset.action;
            if (action) sendInput(action);
          });
        });
      }
      quickActions.classList.remove('hidden');
    } else {
      quickActions.classList.add('hidden');
    }
  } else {
    quickActions.classList.add('hidden');
  }
}

// ── Session selection ──
function selectSession(sessionId: string): void {
  selectedSessionId = sessionId;
  history.replaceState(null, '', `#session=${sessionId}`);

  emptyState.classList.add('hidden');
  sessionView.classList.remove('hidden');

  // Mobile: show content, hide sidebar
  $('main').classList.add('session-open');

  updateSessionHeader();
  renderSessionList();

  // Subscribe to this session
  send({ type: 'subscribe', sessionId });

  const session = sessions.find(s => s.id === sessionId);

  if (session?.type === 'spawned') {
    // Spawned session: show terminal view
    $('chat-view').classList.add('hidden');
    $('terminal-view').classList.remove('hidden');
    $('input-bar').classList.add('hidden');
    terminalView.initInteractive(
      (data) => send({ type: 'send-input', sessionId, text: data }),
      (cols, rows) => send({ type: 'resize', sessionId, cols, rows }),
    );
  } else {
    // Discovered/terminated session: show chat view
    $('chat-view').classList.remove('hidden');
    $('terminal-view').classList.add('hidden');
    if (isEditMode) {
      $('input-bar').classList.remove('hidden');
    }
    terminalView.destroy();
    chatView.clear();
  }
}

function goBack(): void {
  history.replaceState(null, '', location.pathname);
  $('main').classList.remove('session-open');
  selectedSessionId = null;
  sessionView.classList.add('hidden');
  emptyState.classList.remove('hidden');
  terminalView.destroy();
  renderSessionList();
}

// ── Resume session ──
function resumeSession(): void {
  if (!selectedSessionId) return;
  const session = sessions.find(s => s.id === selectedSessionId);
  if (!session || session.type !== 'terminated' || !session.claudeSessionId) return;

  send({ type: 'resume-session', sessionId: selectedSessionId });
}

// ── Rename session ──
function startRename(): void {
  if (!selectedSessionId) return;
  const session = sessions.find(s => s.id === selectedSessionId);
  if (!session) return;

  const currentName = session.customName || session.projectName || '';
  const titleEl = sessionTitle;

  // Replace title with an input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = currentName;
  input.placeholder = session.projectName || 'Session name...';

  const finish = () => {
    const newName = input.value.trim();
    send({ type: 'rename-session', sessionId: selectedSessionId!, name: newName });
    titleEl.textContent = newName || session.projectName || `Session ${session.id.slice(0, 8)}`;
    titleEl.style.display = '';
    input.remove();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') {
      titleEl.style.display = '';
      input.remove();
    }
  });
  input.addEventListener('blur', finish);

  titleEl.style.display = 'none';
  titleEl.parentElement!.insertBefore(input, titleEl);
  input.focus();
  input.select();
}

// ── Terminate session ──
function terminateSession(): void {
  if (!selectedSessionId) return;
  const session = sessions.find(s => s.id === selectedSessionId);
  if (!session) return;

  if (!confirm(`Terminate session "${session.projectName || session.id}"?`)) return;

  send({ type: 'terminate-session', sessionId: selectedSessionId });
}

// ── Input handling ──
function sendInput(text: string): void {
  if (!selectedSessionId || !text.trim()) return;
  send({ type: 'send-input', sessionId: selectedSessionId, text: text.trim() });
  inputText.value = '';
  inputText.style.height = 'auto';

  // Clear attention state
  const session = sessions.find(s => s.id === selectedSessionId);
  if (session) {
    session.status = 'active';
    session.attentionReason = undefined;
    quickActions.classList.add('hidden');
    renderSessionList();
  }
}

// ── Folder Browser ──
async function loadDirectory(dirPath: string): Promise<void> {
  try {
    const resp = await fetch(`/api/directories?path=${encodeURIComponent(dirPath)}`);
    if (!resp.ok) return;
    const data = await resp.json();

    // Update input
    ($('new-session-cwd') as HTMLInputElement).value = data.path;

    // Render breadcrumb
    const breadcrumb = $('folder-breadcrumb');
    const parts = data.path.split('/').filter(Boolean);
    breadcrumb.innerHTML = '';
    // Root
    const rootSpan = document.createElement('span');
    rootSpan.textContent = '/';
    rootSpan.addEventListener('click', () => loadDirectory('/'));
    breadcrumb.appendChild(rootSpan);

    let accumulated = '';
    for (const part of parts) {
      accumulated += '/' + part;
      const sep = document.createElement('span');
      sep.className = 'separator';
      sep.textContent = '/';
      breadcrumb.appendChild(sep);

      const crumb = document.createElement('span');
      crumb.textContent = part;
      const target = accumulated;
      crumb.addEventListener('click', () => loadDirectory(target));
      breadcrumb.appendChild(crumb);
    }

    // Render folder list
    const list = $('folder-list');
    if (data.dirs.length === 0) {
      list.innerHTML = '<div class="folder-empty">No subdirectories</div>';
      return;
    }

    list.innerHTML = '';
    for (const dir of data.dirs) {
      const fullPath = data.path === '/' ? '/' + dir : data.path + '/' + dir;
      const item = document.createElement('div');
      item.className = 'folder-item';

      // Check if this subfolder is a git repo by peeking ahead
      // We'll mark the current dir if it has .git
      item.innerHTML = `<span class="folder-icon">&#128193;</span><span>${escapeHtml(dir)}</span>`;
      item.addEventListener('click', () => loadDirectory(fullPath));
      list.appendChild(item);
    }

    // If current dir has .git, highlight the "Create" button
    if (data.hasGit) {
      $('btn-modal-create').textContent = 'Create (git project)';
    } else {
      $('btn-modal-create').textContent = 'Create';
    }
  } catch {
    // ignore
  }
}

// ── Modals ──
function showNewSessionModal(): void {
  $('modal-overlay').classList.remove('hidden');
  loadDirectory('~');
  ($('new-session-cwd') as HTMLInputElement).focus();
}

function hideNewSessionModal(): void {
  $('modal-overlay').classList.add('hidden');
}

function createNewSession(): void {
  const cwd = ($('new-session-cwd') as HTMLInputElement).value.trim();
  if (!cwd) return;

  send({ type: 'create-session', cwd });
  hideNewSessionModal();

  // Auto-select the new session when it appears
  const checkForNew = setInterval(() => {
    const spawned = sessions.find(s => s.type === 'spawned' && s.cwd === cwd && s.status === 'active');
    if (spawned) {
      clearInterval(checkForNew);
      selectSession(spawned.id);
    }
  }, 200);
  // Stop checking after 5s
  setTimeout(() => clearInterval(checkForNew), 5000);
}

function showShareModal(): void {
  $('share-modal-overlay').classList.remove('hidden');
  $('share-url-group').classList.add('hidden');
}

function hideShareModal(): void {
  $('share-modal-overlay').classList.add('hidden');
}

async function generateShareLink(): Promise<void> {
  if (!selectedSessionId) return;

  const interactive = ($('share-interactive') as HTMLInputElement).checked;

  const resp = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selectedSessionId, interactive }),
  });

  const { url } = await resp.json();
  const fullUrl = `${location.origin}${url}`;

  ($('share-url') as HTMLInputElement).value = fullUrl;
  $('share-url-group').classList.remove('hidden');
}

// ── Utilities ──
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getQuickActionsForReason(reason: string): string[] {
  if (/permission/i.test(reason)) return ['Allow', 'Deny'];
  if (/confirmation/i.test(reason)) return ['Yes', 'No'];
  if (/edit approval/i.test(reason)) return ['Accept', 'Reject'];
  if (/waiting for enter/i.test(reason)) return ['Enter'];
  if (/question prompt/i.test(reason)) return ['1', '2', '3', '4'];
  return [];
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'var(--green)';
    case 'attention': return 'var(--orange)';
    case 'idle': return 'var(--text-muted)';
    case 'dead': return 'var(--red)';
    case 'terminated': return 'var(--text-muted)';
    default: return 'var(--text-muted)';
  }
}

// ── Sidebar resize ──
function initSidebarResize(): void {
  const sidebar = $('sidebar');
  const handle = $('sidebar-resize-handle');
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = startWidth + (ev.clientX - startX);
      const clamped = Math.max(180, Math.min(600, newWidth));
      sidebar.style.width = clamped + 'px';
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ── Theme ──
function initTheme(): void {
  const saved = localStorage.getItem('theme') || 'dark';
  document.body.setAttribute('data-theme', saved);
  updateThemeButton(saved);

  $('btn-theme').addEventListener('click', () => {
    const current = document.body.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeButton(next);
  });
}

function updateThemeButton(theme: string): void {
  // Moon for dark, sun for light
  $('btn-theme').innerHTML = theme === 'dark' ? '&#9790;' : '&#9728;';
}

// ── Event listeners ──
function init(): void {
  // Theme
  initTheme();

  // Wire question answer callback to send input to the session
  setOnAnswerCallback((answer: string) => sendInput(answer));

  // Start with edit controls disabled; server will enable via access-level message
  applyEditMode();

  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Sidebar resize
  initSidebarResize();

  // Search
  const searchInput = $('session-search') as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderSessionList();
  });

  // Input: Enter sends, Shift+Enter inserts newline
  $('btn-send').addEventListener('click', () => sendInput(inputText.value));
  inputText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput(inputText.value);
    }
  });
  inputText.addEventListener('input', () => {
    // Auto-resize textarea to fit content
    inputText.style.height = 'auto';
    inputText.style.height = Math.min(inputText.scrollHeight, 200) + 'px';
  });

  // Back button (mobile)
  $('btn-back').addEventListener('click', goBack);

  // Resume button
  $('btn-resume').addEventListener('click', resumeSession);
  $('btn-terminate').addEventListener('click', terminateSession);

  // Double-click title to rename
  sessionTitle.addEventListener('dblclick', startRename);

  // New session modal
  $('btn-new-session').addEventListener('click', showNewSessionModal);
  $('btn-modal-cancel').addEventListener('click', hideNewSessionModal);
  $('btn-modal-create').addEventListener('click', createNewSession);
  ($('new-session-cwd') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createNewSession();
    if (e.key === 'Escape') hideNewSessionModal();
  });

  // Share modal
  $('btn-share').addEventListener('click', showShareModal);
  $('btn-share-cancel').addEventListener('click', hideShareModal);
  $('btn-share-generate').addEventListener('click', generateShareLink);
  $('btn-copy-share').addEventListener('click', () => {
    const url = ($('share-url') as HTMLInputElement).value;
    navigator.clipboard.writeText(url);
  });

  // Close modals on overlay click
  $('modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('modal-overlay')) hideNewSessionModal();
  });
  $('share-modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('share-modal-overlay')) hideShareModal();
  });

  // Check if this is a share URL
  const sharePath = location.pathname.match(/^\/share\/(.+)/);
  if (sharePath) {
    initShareView(sharePath[1]);
    return;
  }

  // Connect WebSocket
  connect();
}

async function initShareView(token: string): Promise<void> {
  isSharedView = true;

  // Hide all controls not available in shared view
  $('btn-new-session').classList.add('hidden');
  $('btn-share').classList.add('hidden');
  $('btn-resume').classList.add('hidden');
  $('btn-terminate').classList.add('hidden');
  $('sidebar').classList.add('hidden');
  $('btn-theme').classList.add('hidden');

  // Make content area full width
  const content = $('content') as HTMLElement;
  content.style.marginLeft = '0';
  content.style.width = '100%';

  // Update title for shared view
  document.querySelector('#topbar h1')!.textContent = 'Terminal Manager (Shared)';

  // Hide input bar in shared view by default
  $('input-bar').classList.add('hidden');

  const resp = await fetch(`/api/share/${token}`);
  if (!resp.ok) {
    emptyState.querySelector('.empty-icon')!.textContent = '🔗';
    emptyState.querySelector('h2')!.textContent = 'Share link expired';
    emptyState.querySelector('p')!.textContent = 'This link is no longer valid. Ask the session owner for a new one.';
    return;
  }

  const { sessionId, interactive } = await resp.json();
  shareToken = token;

  // Show input bar only if interactive
  if (interactive) {
    $('input-bar').classList.remove('hidden');
  }

  connect();

  // Wait for connection then subscribe
  const interval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      clearInterval(interval);
      selectSession(sessionId);
    }
  }, 200);
}

// ── Start ──
document.addEventListener('DOMContentLoaded', init);
