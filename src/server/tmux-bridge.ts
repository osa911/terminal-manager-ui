import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import { ITermSession } from './types';
import { TerminalBridge } from './terminal-bridge';

const execFileAsync = promisify(execFileCb);

interface TmuxPane {
  sessionName: string;
  windowIndex: string;
  paneIndex: string;
  tty: string;
  pid: string;
  active: string;
}

/**
 * Terminal bridge that uses tmux CLI to enumerate panes, read content, and send input.
 * When no tmux server is running, all methods gracefully return empty/no-op results.
 *
 * Session ID format: `tmux:<session>:<window>:<pane>` (e.g. `tmux:0:1:0`)
 */
export class TmuxBridge implements TerminalBridge {
  readonly supportsContentReading = true;

  /** Cache of panes indexed by normalized TTY path */
  private panesByTty = new Map<string, TmuxPane>();

  static isTmuxRunning(): boolean {
    try {
      execFileSync('tmux', ['list-sessions'], { timeout: 3000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private static normalizeTtyPath(tty: string): string {
    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  }

  private static buildTarget(pane: TmuxPane): string {
    return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
  }

  private static buildSessionId(pane: TmuxPane): string {
    return `tmux:${pane.sessionName}:${pane.windowIndex}:${pane.paneIndex}`;
  }

  private static parseSessionId(sessionId: string): { session: string; window: string; pane: string } | null {
    const match = sessionId.match(/^tmux:(.+):(\d+):(\d+)$/);
    if (!match) return null;
    return { session: match[1], window: match[2], pane: match[3] };
  }

  private async refreshPaneCache(): Promise<TmuxPane[]> {
    this.panesByTty.clear();

    try {
      const { stdout } = await execFileAsync('tmux', [
        'list-panes', '-a', '-F',
        '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_tty}\t#{pane_pid}\t#{pane_active}',
      ], { timeout: 5000 });

      const panes: TmuxPane[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [sessionName, windowIndex, paneIndex, tty, pid, active] = line.split('\t');
        const pane: TmuxPane = { sessionName, windowIndex, paneIndex, tty, pid, active };
        panes.push(pane);

        this.panesByTty.set(TmuxBridge.normalizeTtyPath(tty), pane);
      }

      return panes;
    } catch {
      // tmux not running or no sessions
      return [];
    }
  }

  async enumerateSessions(): Promise<ITermSession[]> {
    const panes = await this.refreshPaneCache();

    return panes.map(pane => ({
      id: TmuxBridge.buildSessionId(pane),
      name: `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`,
      tty: TmuxBridge.normalizeTtyPath(pane.tty),
      isProcessing: pane.active === '1',
      windowId: `${pane.sessionName}:${pane.windowIndex}`,
      tabId: pane.sessionName,
    }));
  }

  async getSessionContentByTty(tty: string): Promise<string> {
    const normalizedTty = TmuxBridge.normalizeTtyPath(tty);
    const pane = this.panesByTty.get(normalizedTty);
    if (!pane) return '';

    return this.capturePane(TmuxBridge.buildTarget(pane));
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const parsed = TmuxBridge.parseSessionId(sessionId);
    if (parsed) {
      const target = `${parsed.session}:${parsed.window}.${parsed.pane}`;
      await this.sendKeys(target, text);
    }
  }

  async sendInputByTty(tty: string, text: string): Promise<boolean> {
    const normalizedTty = TmuxBridge.normalizeTtyPath(tty);
    const pane = this.panesByTty.get(normalizedTty);
    if (!pane) return false;

    return this.sendKeys(TmuxBridge.buildTarget(pane), text);
  }

  async focusSession(sessionId: string): Promise<void> {
    const parsed = TmuxBridge.parseSessionId(sessionId);
    if (!parsed) return;

    try {
      await execFileAsync('tmux', [
        'select-window', '-t', `${parsed.session}:${parsed.window}`,
      ], { timeout: 5000 });
      await execFileAsync('tmux', [
        'select-pane', '-t', `${parsed.session}:${parsed.window}.${parsed.pane}`,
      ], { timeout: 5000 });
    } catch {
      // Session/window/pane may have closed
    }
  }

  /** Send text followed by Enter to a tmux target. Returns true on success. */
  private async sendKeys(target: string, text: string): Promise<boolean> {
    try {
      await execFileAsync('tmux', ['send-keys', '-t', target, '-l', text], { timeout: 5000 });
      await execFileAsync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private async capturePane(target: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('tmux', [
        'capture-pane', '-t', target, '-p', '-S', '-200',
      ], { timeout: 5000 });
      return stdout;
    } catch {
      return '';
    }
  }
}
