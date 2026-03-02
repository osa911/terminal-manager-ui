import { EventEmitter } from 'events';
import * as fs from 'fs';
import { Session } from './types';
import { getSessionContentByTty } from './iterm-bridge';
import { JsonlWatcher } from './jsonl-watcher';

const CHECK_INTERVAL = 1000; // How often to check all sessions
const ACTIVE_THRESHOLD = 2000; // Consider idle if JSONL file unchanged for this long

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
  private checkTimer: NodeJS.Timeout | null = null;
  private getSessionsFn: (() => Session[]) | null = null;

  /**
   * Periodically check all sessions' JSONL file mtime.
   * If the file was recently modified → active.
   * If not → check terminal for attention patterns → idle.
   */
  start(getSessionsFn: () => Session[], _jsonlWatcher: JsonlWatcher): void {
    this.getSessionsFn = getSessionsFn;

    this.checkTimer = setInterval(() => {
      this.checkAllSessions();
    }, CHECK_INTERVAL);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private checkAllSessions(): void {
    if (!this.getSessionsFn) return;
    const sessions = this.getSessionsFn();
    const now = Date.now();

    for (const session of sessions) {
      if (session.type !== 'discovered' && session.type !== 'spawned') continue;
      if (session.status === 'dead' || session.status === 'terminated') continue;

      // Check JSONL file mtime to determine if actively writing
      let lastModified = 0;
      if (session.jsonlPath) {
        try {
          const stat = fs.statSync(session.jsonlPath);
          lastModified = stat.mtimeMs;
        } catch {
          // File might not exist
        }
      }

      const isRecentlyActive = (now - lastModified) < ACTIVE_THRESHOLD;
      const prevStatus = session.status;

      if (isRecentlyActive) {
        session.status = 'active';
        session.attentionReason = undefined;
      } else {
        // Not recently active — check terminal for attention patterns
        this.checkTerminalStatus(session);
        // checkTerminalStatus is async, status updated asynchronously
        continue;
      }

      if (session.status !== prevStatus) {
        this.emit('status-changed', session.id);
      }
    }
  }

  private async checkTerminalStatus(session: Session): Promise<void> {
    const prevStatus = session.status;

    if (!session.tty) {
      session.status = 'idle';
      session.attentionReason = undefined;
      if (prevStatus !== 'idle') this.emit('status-changed', session.id);
      return;
    }

    try {
      const content = await getSessionContentByTty(session.tty);
      if (!content) {
        session.status = 'idle';
        session.attentionReason = undefined;
        if (prevStatus !== 'idle') this.emit('status-changed', session.id);
        return;
      }

      const lastLines = content.split('\n').slice(-10).join('\n');
      const reason = this.detectAttention(lastLines);

      if (reason) {
        session.status = 'attention';
        session.attentionReason = reason;
        if (prevStatus !== 'attention') {
          this.emit('attention-needed', session.id, reason);
        }
      } else {
        session.status = 'idle';
        session.attentionReason = undefined;
      }
    } catch {
      session.status = 'idle';
      session.attentionReason = undefined;
    }

    if (session.status !== prevStatus) {
      this.emit('status-changed', session.id);
    }
  }

  private detectAttention(content: string): string | null {
    const lastLines = content.split('\n').slice(-5).join('\n');
    for (const { pattern, reason } of ATTENTION_PATTERNS) {
      if (pattern.test(lastLines)) {
        return reason;
      }
    }
    return null;
  }
}
