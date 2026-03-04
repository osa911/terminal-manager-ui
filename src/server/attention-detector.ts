import { EventEmitter } from 'events';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { Session, QuickAction } from './types';
import { TerminalBridge } from './terminal-bridge';

const CHECK_INTERVAL = 1500;
const TERMINAL_INFO_INTERVAL = 3000;
const HOOK_STATUS_DIR = '/tmp/claude-status';
const CPU_ACTIVE_THRESHOLD = 15;
const ACTIVE_COOLDOWN = 12000;

const ATTENTION_PATTERNS = [
  { pattern: /\?\s*\(y\)es\s*\(n\)o/i, reason: 'Permission prompt' },
  { pattern: /\(Y\)es\s*\/\s*\(N\)o/i, reason: 'Confirmation prompt' },
  { pattern: /\[Y\/n\]/i, reason: 'Confirmation prompt' },
  { pattern: /\[y\/N\]/i, reason: 'Confirmation prompt' },
  { pattern: /Press Enter to continue/i, reason: 'Waiting for Enter' },
  { pattern: /Do you want to proceed/i, reason: 'Confirmation prompt' },
  { pattern: /[❯›]\s*[◯◉●○]/, reason: 'Question prompt' },
  { pattern: /\(Use arrow keys\)/i, reason: 'Question prompt' },
];

export class AttentionDetector extends EventEmitter {
  private statusTimer: NodeJS.Timeout | null = null;
  private terminalInfoTimer: NodeJS.Timeout | null = null;
  private getSessionsFn: (() => Session[]) | null = null;
  private bridge: TerminalBridge | null = null;
  private lastActiveTime = new Map<string, number>();

  start(getSessionsFn: () => Session[], bridge: TerminalBridge): void {
    this.getSessionsFn = getSessionsFn;
    this.bridge = bridge;

    this.statusTimer = setInterval(() => {
      this.checkStatus();
    }, CHECK_INTERVAL);

    // Only start terminal content polling when the bridge can read content
    if (bridge.supportsContentReading) {
      this.terminalInfoTimer = setInterval(() => {
        this.updateTerminalInfo();
      }, TERMINAL_INFO_INTERVAL);
    }
  }

  stop(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.terminalInfoTimer) {
      clearInterval(this.terminalInfoTimer);
      this.terminalInfoTimer = null;
    }
  }

  private static getCpuBatch(pids: number[]): Map<number, number> {
    if (pids.length === 0) return new Map();
    try {
      const output = execSync(`ps -o pid=,%cpu= -p ${pids.join(',')}`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
      const result = new Map<number, number>();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          result.set(parseInt(parts[0]), parseFloat(parts[1]));
        }
      }
      return result;
    } catch {
      return new Map();
    }
  }

  /**
   * Read hook-written status file for a Claude session.
   * Returns 'active' | 'idle' | 'attention' | null (no file = no hook data yet)
   */
  private static readHookStatus(claudeSessionId: string): string | null {
    try {
      return fs.readFileSync(`${HOOK_STATUS_DIR}/${claudeSessionId}`, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  private static stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * Fast status check (1.5s) using hooks + CPU + isProcessing.
   *
   * Hook priority (hooks are the most reliable signal):
   * 1. hookStatus === 'attention' -> attention (permission/elicitation prompt)
   * 2. hookStatus === 'idle' -> idle (trust hook, ignore CPU/isProcessing)
   * 3. hookStatus === 'active' -> active
   * 4. hookStatus === null -> fallback to CPU/isProcessing + cooldown
   */
  private async checkStatus(): Promise<void> {
    if (!this.getSessionsFn) return;
    const sessions = this.getSessionsFn();

    const liveSessions = sessions.filter(
      s => (s.type === 'discovered' || s.type === 'spawned')
        && s.status !== 'dead' && s.status !== 'terminated'
    );

    const pids = liveSessions.filter(s => s.pid).map(s => s.pid!);
    const [itermSessions, cpuMap] = await Promise.all([
      this.bridge!.enumerateSessions(),
      Promise.resolve(AttentionDetector.getCpuBatch(pids)),
    ]);
    const itermByTty = new Map(itermSessions.map(s => [s.tty, s]));

    const now = Date.now();

    for (const session of liveSessions) {
      const prevStatus = session.status;
      const ttyPath = session.tty
        ? (session.tty.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`)
        : null;

      // Signal 1 (primary): Hook status file written by Claude Code hooks
      const hookStatus = session.claudeSessionId
        ? AttentionDetector.readHookStatus(session.claudeSessionId)
        : null;

      // Signal 2: iTerm2 isProcessing
      const itermInfo = ttyPath ? itermByTty.get(ttyPath) : null;
      const isTerminalBusy = itermInfo?.isProcessing ?? false;

      // Signal 3: CPU usage
      const cpu = session.pid ? (cpuMap.get(session.pid) ?? 0) : 0;
      const isCpuBusy = cpu > CPU_ACTIVE_THRESHOLD;

      // -- Hook-based decisions (authoritative) --
      if (hookStatus === 'attention') {
        session.status = 'attention';
        session.attentionReason = 'Permission or input prompt';
        this.lastActiveTime.delete(session.id);

        // Parse quick actions from terminal content on first attention detection
        if (prevStatus !== 'attention' && session.tty && this.bridge?.supportsContentReading) {
          try {
            const content = await this.bridge.getSessionContentByTty(session.tty);
            if (content) {
              session.quickActions = AttentionDetector.parseQuickActions(content);
            }
          } catch { /* ignore */ }
        }

        if (prevStatus !== 'attention') {
          this.emit('attention-needed', session.id, session.attentionReason, session.quickActions);
        }
      } else if (hookStatus === 'idle') {
        // Trust hook completely, ignore CPU/isProcessing
        this.lastActiveTime.delete(session.id);
        session.status = 'idle';
        session.attentionReason = undefined;
        session.quickActions = undefined;
      } else if (hookStatus === 'active') {
        this.lastActiveTime.set(session.id, now);
        session.status = 'active';
        session.attentionReason = undefined;
        session.quickActions = undefined;
      } else {
        // -- No hook data -- fallback to heuristics --
        const signalActive = isTerminalBusy || isCpuBusy;

        if (signalActive) {
          this.lastActiveTime.set(session.id, now);
        }

        const withinCooldown = (now - (this.lastActiveTime.get(session.id) || 0)) < ACTIVE_COOLDOWN;
        const isActive = signalActive || withinCooldown;

        if (isActive) {
          session.status = 'active';
          session.attentionReason = undefined;
        } else if (session.status === 'active') {
          session.status = 'idle';
          session.attentionReason = undefined;
        }
      }

      if (session.status !== prevStatus) {
        this.emit('status-changed', session.id);
      }
    }
  }

  /**
   * Terminal content check (3s) -- reads terminal output for all live sessions.
   * - Extracts Claude status line (e.g. "* Compacting conversation...") for statusText
   * - Checks attention patterns for non-active/non-attention sessions (fallback)
   */
  private async updateTerminalInfo(): Promise<void> {
    if (!this.getSessionsFn) return;
    const sessions = this.getSessionsFn();

    const liveSessions = sessions.filter(
      s => (s.type === 'discovered' || s.type === 'spawned')
        && s.status !== 'dead' && s.status !== 'terminated'
        && s.tty
    );

    await Promise.all(liveSessions.map(s => this.updateSessionTerminalInfo(s)));
  }

  private async updateSessionTerminalInfo(session: Session): Promise<void> {
    const prevStatus = session.status;
    const prevStatusText = session.statusText;

    try {
      const content = await this.bridge!.getSessionContentByTty(session.tty!);

      if (content) {
        // Extract Claude status line for all sessions (active, idle, etc.)
        session.statusText = AttentionDetector.extractClaudeStatusLine(content) || undefined;

        // Refresh quick actions for sessions in attention state
        if (session.status === 'attention') {
          session.quickActions = AttentionDetector.parseQuickActions(content);
        }

        // Only check attention patterns for sessions not already handled by hooks
        if (session.status !== 'active' && session.status !== 'attention') {
          const lastLines = content.split('\n').slice(-10).join('\n');
          const reason = AttentionDetector.detectAttention(lastLines);

          if (reason) {
            session.status = 'attention';
            session.attentionReason = reason;
            session.quickActions = AttentionDetector.parseQuickActions(content);
            if (prevStatus !== 'attention') {
              this.emit('attention-needed', session.id, reason, session.quickActions);
            }
          }
        }
      } else {
        session.statusText = undefined;
      }
    } catch {
      session.statusText = undefined;
    }

    if (session.status !== prevStatus || session.statusText !== prevStatusText) {
      this.emit('status-changed', session.id);
    }
  }

  /**
   * Extract the last Claude status line from terminal content.
   * Looks for lines starting with special Unicode indicators.
   */
  private static extractClaudeStatusLine(content: string): string | null {
    const lines = content.split('\n');
    const start = Math.max(0, lines.length - 20);

    for (let i = lines.length - 1; i >= start; i--) {
      const line = AttentionDetector.stripAnsi(lines[i]).trim();
      if (!line) continue;
      if (/^[✽✳]/.test(line)) {
        return line;
      }
    }
    return null;
  }

  private static detectAttention(content: string): string | null {
    const lastLines = content.split('\n').slice(-5).join('\n');
    for (const { pattern, reason } of ATTENTION_PATTERNS) {
      if (pattern.test(lastLines)) {
        return reason;
      }
    }
    return null;
  }

  /**
   * Parse quick actions from terminal content by looking at the last 25 lines.
   * Handles: numbered options, y/n prompts, Enter prompts.
   */
  static parseQuickActions(content: string): QuickAction[] {
    const lines = content.split('\n').slice(-25).map(l => AttentionDetector.stripAnsi(l));

    // 1. Numbered options (Claude plan approval, AskUserQuestion, etc.)
    //    e.g. "› 1. Yes, clear context..." or "  2. Yes, auto-accept edits"
    const numbered: QuickAction[] = [];
    for (const line of lines) {
      const match = line.match(/^\s*[›❯>]?\s*(\d+)\.\s+(.+)$/);
      if (match) {
        numbered.push({ label: match[2].trim(), value: match[1] });
      }
    }
    if (numbered.length >= 2) return numbered;

    // 2. Permission prompt: ? (y)es (n)o
    const tail = lines.slice(-8).join('\n');
    if (/\(y\)es.*\(n\)o/i.test(tail)) {
      return [
        { label: 'Allow', value: 'y' },
        { label: 'Deny', value: 'n' },
      ];
    }

    // 3. Confirmation: [Y/n] or [y/N]
    if (/\[Y\/n\]/i.test(tail) || /\[y\/N\]/i.test(tail)) {
      return [
        { label: 'Yes', value: 'y' },
        { label: 'No', value: 'n' },
      ];
    }

    // 4. Press Enter to continue
    if (/Press Enter to continue/i.test(tail)) {
      return [{ label: 'Continue', value: '' }];
    }

    return [];
  }
}
