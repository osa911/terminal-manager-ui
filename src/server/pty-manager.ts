import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import * as path from 'path';
import { Session } from './types';

interface PtySession {
  process: pty.IPty;
  session: Session;
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySession>();

  /**
   * Create a new Claude session in the given directory.
   */
  createSession(cwd: string): Session {
    const id = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.spawnClaude(id, cwd, []);
  }

  /**
   * Resume a terminated Claude session using `claude --resume`.
   */
  resumeSession(claudeSessionId: string, cwd: string, originalSessionId: string): Session {
    const id = `resumed-${claudeSessionId.slice(0, 8)}-${Date.now()}`;
    return this.spawnClaude(id, cwd, ['--resume', claudeSessionId], originalSessionId);
  }

  private spawnClaude(id: string, cwd: string, args: string[], replacesSessionId?: string): Session {
    const claudePath = process.env.HOME + '/.local/bin/claude';
    const ptyProcess = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        CLAUDECODE: '',
      },
    });

    const session: Session = {
      id,
      type: 'spawned',
      pid: ptyProcess.pid,
      cwd,
      projectName: path.basename(cwd),
      status: 'active',
      lastActivity: Date.now(),
      startedAt: Date.now(),
    };

    const ptySession: PtySession = { process: ptyProcess, session };
    this.sessions.set(id, ptySession);

    ptyProcess.onData((data) => {
      session.lastActivity = Date.now();
      this.emit('data', id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.status = 'dead';
      this.emit('exit', id, exitCode);
      this.sessions.delete(id);
    });

    // If this replaces a terminated session, emit an event so the server can clean up
    if (replacesSessionId) {
      this.emit('session-replaced', replacesSessionId, id);
    }

    return session;
  }

  sendInput(sessionId: string, data: string): void {
    const ptySession = this.sessions.get(sessionId);
    if (ptySession) {
      ptySession.process.write(data);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const ptySession = this.sessions.get(sessionId);
    if (ptySession) {
      ptySession.process.resize(cols, rows);
    }
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map(s => s.session);
  }

  killSession(sessionId: string): void {
    const ptySession = this.sessions.get(sessionId);
    if (ptySession) {
      ptySession.process.kill();
      this.sessions.delete(sessionId);
    }
  }

  destroy(): void {
    for (const [id] of this.sessions) {
      this.killSession(id);
    }
  }
}
