import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { ChatMessage, JsonlEntry, JsonlContentBlock } from './types';

export class JsonlWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private fileOffsets = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  private claudeDir: string;

  constructor() {
    super();
    this.claudeDir = path.join(process.env.HOME || '~', '.claude', 'projects');
  }

  /**
   * Get the last time a JSONL file was modified (event-driven, not stat-based).
   * Returns 0 if no activity has been observed.
   */
  getLastActivity(filePath: string): number {
    return this.lastActivity.get(filePath) || 0;
  }

  start(): void {
    if (this.watcher) return;

    const watchPath = path.join(this.claudeDir, '**', '*.jsonl');
    this.watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', (filePath) => {
      this.lastActivity.set(filePath, Date.now());
      this.emit('activity', filePath);
      this.readNewLines(filePath);
    });

    this.watcher.on('add', (filePath) => {
      this.fileOffsets.set(filePath, 0);
    });

    this.watcher.on('error', (error) => {
      console.error('JSONL watcher error:', error);
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Read the full conversation from a JSONL file.
   */
  readFullConversation(filePath: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JsonlEntry;
          const parsed = this.parseEntry(entry);
          messages.push(...parsed);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File might not exist or be readable
    }

    // Set offset to end of file so we only get new messages going forward
    try {
      const stats = fs.statSync(filePath);
      this.fileOffsets.set(filePath, stats.size);
    } catch {
      // Ignore
    }

    return messages;
  }

  /**
   * Find the most recent JSONL file for a given project path.
   */
  findSessionFile(projectPath: string): string | null {
    // Claude encodes project paths by replacing non-alphanumeric chars with dashes
    const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');

    const projectDir = path.join(this.claudeDir, encodedPath);
    const result = this.findMostRecentJsonl(projectDir);
    if (result) return result;

    // Fallback: scan all project dirs for one whose name matches the basename
    try {
      const basename = path.basename(projectPath);
      const dirs = fs.readdirSync(this.claudeDir);
      for (const dir of dirs) {
        if (dir.endsWith('-' + basename) || dir === basename) {
          const alt = this.findMostRecentJsonl(path.join(this.claudeDir, dir));
          if (alt) return alt;
        }
      }
    } catch {
      // Ignore
    }

    return null;
  }

  private findMostRecentJsonl(dirPath: string): string | null {
    try {
      if (!fs.existsSync(dirPath)) return null;

      const files = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: path.join(dirPath, f),
          mtime: fs.statSync(path.join(dirPath, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      return files.length > 0 ? files[0].path : null;
    } catch {
      return null;
    }
  }

  /**
   * Find all recent JSONL session files across all projects.
   */
  findAllRecentSessions(maxAge: number = 24 * 60 * 60 * 1000): Map<string, string> {
    const sessions = new Map<string, string>();
    const now = Date.now();

    try {
      if (!fs.existsSync(this.claudeDir)) return sessions;

      const projectDirs = fs.readdirSync(this.claudeDir);
      for (const dir of projectDirs) {
        const dirPath = path.join(this.claudeDir, dir);
        try {
          const stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) continue;

          const files = fs.readdirSync(dirPath)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const fullPath = path.join(dirPath, f);
              return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
            })
            .filter(f => now - f.mtime < maxAge)
            .sort((a, b) => b.mtime - a.mtime);

          if (files.length > 0) {
            const sessionId = path.basename(files[0].name, '.jsonl');
            sessions.set(sessionId, files[0].path);
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Ignore
    }

    return sessions;
  }

  private readNewLines(filePath: string): void {
    const offset = this.fileOffsets.get(filePath) || 0;

    try {
      const stats = fs.statSync(filePath);
      if (stats.size <= offset) return;

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(stats.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);

      this.fileOffsets.set(filePath, stats.size);

      const newContent = buffer.toString('utf-8');
      const lines = newContent.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JsonlEntry;
          const messages = this.parseEntry(entry);
          for (const message of messages) {
            this.emit('message', filePath, message);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File might have been removed
    }
  }

  /**
   * Parse a single JSONL entry into one or more ChatMessages.
   * Each JSONL line can contain multiple content blocks (thinking, text, tool_use, tool_result).
   */
  private parseEntry(entry: JsonlEntry): ChatMessage[] {
    // Only parse user/assistant message entries
    if (!entry.message || (entry.type !== 'user' && entry.type !== 'assistant')) {
      return [];
    }

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    const entryType = entry.type; // 'user' or 'assistant'

    // Simple string content
    if (typeof entry.message.content === 'string') {
      return [{
        id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        role: entryType === 'user' ? 'user' : 'assistant',
        content: entry.message.content,
        timestamp,
        type: 'text',
      }];
    }

    if (!Array.isArray(entry.message.content)) return [];

    const blocks = entry.message.content as JsonlContentBlock[];
    const messages: ChatMessage[] = [];

    // Collect text blocks together, emit others individually
    const textParts: string[] = [];
    let thinkingParts: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) textParts.push(block.text);
          break;

        case 'thinking':
          if (block.thinking) thinkingParts.push(block.thinking);
          break;

        case 'tool_use':
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            // Parse as interactive question
            const qs = block.input.questions as { question: string; options: { label: string; description?: string }[] }[];
            messages.push({
              id: `${timestamp}-q-${Math.random().toString(36).slice(2, 8)}`,
              role: 'assistant',
              content: qs.map(q => q.question).join('\n'),
              timestamp,
              type: 'question',
              questions: qs,
            });
          } else {
            messages.push({
              id: `${timestamp}-tu-${Math.random().toString(36).slice(2, 8)}`,
              role: 'assistant',
              content: block.name || 'unknown tool',
              timestamp,
              type: 'tool_use',
              toolName: block.name,
              toolInput: block.input ? JSON.stringify(block.input, null, 2) : undefined,
              collapsed: true,
            });
          }
          break;

        case 'tool_result': {
          const resultText = extractToolResultText(block);
          messages.push({
            id: `${timestamp}-tr-${Math.random().toString(36).slice(2, 8)}`,
            role: 'tool',
            content: resultText,
            timestamp,
            type: 'tool_result',
            collapsed: true,
          });
          break;
        }
      }
    }

    // Prepend thinking (collapsed) before text
    if (thinkingParts.length > 0) {
      messages.unshift({
        id: `${timestamp}-th-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: thinkingParts.join('\n'),
        timestamp,
        type: 'thinking',
        collapsed: true,
      });
    }

    // Combine all text blocks into a single message
    if (textParts.length > 0) {
      const role = entryType === 'user' ? 'user' : 'assistant';
      messages.push({
        id: `${timestamp}-txt-${Math.random().toString(36).slice(2, 8)}`,
        role,
        content: textParts.join('\n'),
        timestamp,
        type: 'text',
      });
    }

    return messages;
  }
}

function extractToolResultText(block: JsonlContentBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map(c => c.text || '').join('\n');
  }
  return '';
}
