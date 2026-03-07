export interface QuickAction {
  label: string;
  value: string;
}

export interface Session {
  id: string;
  type: 'discovered' | 'spawned' | 'terminated';
  pid?: number;
  tty?: string;
  cwd?: string;
  projectName?: string;
  branch?: string;
  itermSessionId?: string;
  tmuxTarget?: string;
  jsonlPath?: string;
  /** Claude session UUID (for resume) */
  claudeSessionId?: string;
  status: 'active' | 'idle' | 'attention' | 'dead' | 'terminated';
  attentionReason?: string;
  /** Parsed quick actions from terminal content (populated when status=attention) */
  quickActions?: QuickAction[];
  /** Real-time Claude status line extracted from terminal (e.g. "✽ Compacting conversation…") */
  statusText?: string;
  lastActivity: number;
  startedAt?: number;
  /** First user message text (summary) */
  summary?: string;
  /** User-assigned custom name */
  customName?: string;
}

export interface ITermSession {
  id: string;
  name: string;
  tty: string;
  isProcessing: boolean;
  windowId: string;
  tabId: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question';
  toolName?: string;
  toolInput?: string;
  collapsed?: boolean;
  /** For type='question': parsed AskUserQuestion options */
  questions?: { question: string; options: { label: string; description?: string }[] }[];
}

export interface JsonlEntry {
  type: string;
  message?: {
    role: string;
    content: string | JsonlContentBlock[];
  };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  gitBranch?: string;
}

export interface JsonlContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | JsonlToolResultContent[];
  tool_use_id?: string;
}

export interface JsonlToolResultContent {
  type: string;
  text?: string;
}

// WebSocket messages: Server → Client
export type ServerMessage =
  | { type: 'sessions-update'; sessions: Session[] }
  | { type: 'terminal-content'; sessionId: string; content: string }
  | { type: 'chat-messages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'chat-message-append'; sessionId: string; message: ChatMessage }
  | { type: 'attention-needed'; sessionId: string; reason: string; quickActions?: QuickAction[] }
  | { type: 'pty-data'; sessionId: string; data: string };

// WebSocket messages: Client → Server
export type ClientMessage =
  | { type: 'send-input'; sessionId: string; text: string }
  | { type: 'create-session'; cwd: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'resume-session'; sessionId: string }
  | { type: 'terminate-session'; sessionId: string }
  | { type: 'rename-session'; sessionId: string; name: string };
