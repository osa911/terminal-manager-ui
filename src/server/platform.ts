import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCb);

export type Platform = 'darwin-iterm' | 'darwin' | 'linux';

let cachedPlatform: Platform | null = null;

async function probeIterm2(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'tell app "System Events" to (name of processes) contains "iTerm2"'],
      { timeout: 5000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function detectPlatform(): Promise<Platform> {
  if (cachedPlatform) return cachedPlatform;

  if (process.platform === 'linux') {
    cachedPlatform = 'linux';
  } else if (process.platform === 'darwin') {
    const hasIterm = await probeIterm2();
    cachedPlatform = hasIterm ? 'darwin-iterm' : 'darwin';
  } else {
    // Fallback: treat unknown platforms like Linux (generic bridge)
    cachedPlatform = 'linux';
  }

  return cachedPlatform;
}
