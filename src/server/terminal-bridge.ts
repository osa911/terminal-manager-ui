import { ITermSession } from './types';
import { Platform } from './platform';
import { ItermBridge } from './iterm-bridge';
import { GenericBridge } from './generic-bridge';
import { TmuxBridge } from './tmux-bridge';
import { CompositeBridge } from './composite-bridge';

export interface TerminalBridge {
  /** Enumerate terminal sessions (iTerm2/tmux; returns [] on generic). */
  enumerateSessions(): Promise<ITermSession[]>;

  /** Read terminal content by TTY device path. */
  getSessionContentByTty(tty: string): Promise<string>;

  /** Send input to a session by its terminal-specific session ID. */
  sendInput(sessionId: string, text: string): Promise<void>;

  /** Send input by TTY device path. Returns true if the target was found. */
  sendInputByTty(tty: string, text: string): Promise<boolean>;

  /** Whether this bridge can read terminal content (status text, attention patterns). */
  readonly supportsContentReading: boolean;

  /** Optional: focus a session by its terminal-specific session ID. */
  focusSession?(sessionId: string): Promise<void>;
}

export function createBridge(platform: Platform): TerminalBridge {
  const baseBridge = platform === 'darwin-iterm' ? new ItermBridge() : new GenericBridge();
  // TmuxBridge listed first so it gets priority for tmux panes.
  // When tmux isn't running, TmuxBridge.enumerateSessions() returns []
  // and the composite falls through to the base bridge.
  return new CompositeBridge(new TmuxBridge(), baseBridge);
}
