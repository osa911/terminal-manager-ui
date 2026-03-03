import { ITermSession } from './types';
import { Platform } from './platform';
import { ItermBridge } from './iterm-bridge';
import { GenericBridge } from './generic-bridge';

export interface TerminalBridge {
  /** Enumerate terminal sessions (iTerm2 only; returns [] on generic). */
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
  if (platform === 'darwin-iterm') {
    return new ItermBridge();
  }
  return new GenericBridge();
}
