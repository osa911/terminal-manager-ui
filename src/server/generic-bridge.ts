import * as fs from 'fs';
import * as constants from 'constants';
import { ITermSession } from './types';
import { TerminalBridge } from './terminal-bridge';

/**
 * Cross-platform terminal bridge fallback.
 * Works on macOS (without iTerm2) and Linux.
 *
 * - Cannot enumerate terminal sessions or read terminal content.
 * - Can send input by writing directly to the TTY device file.
 */
export class GenericBridge implements TerminalBridge {
  readonly supportsContentReading = false;

  private static normalizeTtyPath(tty: string): string {
    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  }

  async enumerateSessions(): Promise<ITermSession[]> {
    return [];
  }

  async getSessionContentByTty(_tty: string): Promise<string> {
    return '';
  }

  async sendInput(_sessionId: string, _text: string): Promise<void> {
    // No-op: generic bridge has no session registry to look up by ID.
    // Use sendInputByTty instead for discovered sessions.
  }

  async sendInputByTty(tty: string, text: string): Promise<boolean> {
    const ttyPath = GenericBridge.normalizeTtyPath(tty);

    try {
      // O_WRONLY | O_NOCTTY: write without becoming controlling terminal
      const fd = fs.openSync(ttyPath, constants.O_WRONLY | constants.O_NOCTTY);
      try {
        fs.writeSync(fd, text + '\n');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  }
}
