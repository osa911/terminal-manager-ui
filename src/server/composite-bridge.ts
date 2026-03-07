import { ITermSession } from './types';
import { TerminalBridge } from './terminal-bridge';

/**
 * Chains multiple TerminalBridge implementations with TTY ownership tracking.
 * Bridges listed earlier get priority for TTY ownership.
 */
export class CompositeBridge implements TerminalBridge {
  private readonly bridges: TerminalBridge[];
  /** Maps TTY path to the bridge that owns it (first bridge to enumerate it) */
  private ttyOwner = new Map<string, TerminalBridge>();

  constructor(...bridges: TerminalBridge[]) {
    this.bridges = bridges;
  }

  get supportsContentReading(): boolean {
    return this.bridges.some(b => b.supportsContentReading);
  }

  async enumerateSessions(): Promise<ITermSession[]> {
    this.ttyOwner.clear();
    const allSessions: ITermSession[] = [];

    for (const bridge of this.bridges) {
      const sessions = await bridge.enumerateSessions();
      for (const session of sessions) {
        if (session.tty && !this.ttyOwner.has(session.tty)) {
          this.ttyOwner.set(session.tty, bridge);
        }
        allSessions.push(session);
      }
    }

    return allSessions;
  }

  async getSessionContentByTty(tty: string): Promise<string> {
    // Try owning bridge first
    const owner = this.ttyOwner.get(tty);
    if (owner) {
      const content = await owner.getSessionContentByTty(tty);
      if (content) return content;
    }

    // Fall back to other bridges
    for (const bridge of this.bridges) {
      if (bridge === owner) continue;
      const content = await bridge.getSessionContentByTty(tty);
      if (content) return content;
    }

    return '';
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    // Broadcast to all bridges — each ignores unknown IDs
    await Promise.all(this.bridges.map(b => b.sendInput(sessionId, text)));
  }

  async sendInputByTty(tty: string, text: string): Promise<boolean> {
    // Try owning bridge first
    const owner = this.ttyOwner.get(tty);
    if (owner) {
      const sent = await owner.sendInputByTty(tty, text);
      if (sent) return true;
    }

    // Fall back to other bridges
    for (const bridge of this.bridges) {
      if (bridge === owner) continue;
      const sent = await bridge.sendInputByTty(tty, text);
      if (sent) return true;
    }

    return false;
  }

  async focusSession(sessionId: string): Promise<void> {
    for (const bridge of this.bridges) {
      if (bridge.focusSession) {
        await bridge.focusSession(sessionId);
      }
    }
  }
}
