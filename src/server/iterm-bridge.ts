import { execFile } from 'child_process';
import { ITermSession } from './types';

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`AppleScript error: ${err.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function enumerateSessions(): Promise<ITermSession[]> {
  const script = `
    tell application "iTerm2"
      set output to ""
      set windowList to windows
      repeat with w in windowList
        set windowId to id of w as string
        set tabList to tabs of w
        repeat with t in tabList
          set tabId to id of t as string
          set sessionList to sessions of t
          repeat with s in sessionList
            set sessionId to id of s as string
            set sessionName to name of s as string
            set sessionTty to tty of s as string
            set isBusy to (is processing of s) as string
            set output to output & sessionId & "\\t" & sessionName & "\\t" & sessionTty & "\\t" & isBusy & "\\t" & windowId & "\\t" & tabId & "\\n"
          end repeat
        end repeat
      end repeat
      return output
    end tell
  `;

  try {
    const result = await runAppleScript(script);
    if (!result) return [];

    return result.split('\n').filter(Boolean).map(line => {
      const [id, name, tty, isProcessing, windowId, tabId] = line.split('\t');
      return {
        id,
        name: name || '',
        tty: tty || '',
        isProcessing: isProcessing === 'true',
        windowId: windowId || '',
        tabId: tabId || '',
      };
    });
  } catch {
    // Silently return empty — iTerm2 may not be running or accessible
    return [];
  }
}

export async function getSessionContent(sessionId: string): Promise<string> {
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              return contents of s
            end if
          end repeat
        end repeat
      end repeat
      return ""
    end tell
  `;

  try {
    return await runAppleScript(script);
  } catch {
    return '';
  }
}

export async function sendInput(sessionId: string, text: string): Promise<void> {
  // Escape double quotes and backslashes for AppleScript
  const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s to write text "${escapedText}" newline NO
              tell s to write text ""
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `;

  await runAppleScript(script);
}

/**
 * Send input to an iTerm2 session by matching its TTY device.
 * This works even when session enumeration fails, as long as iTerm2 is running.
 */
export async function sendInputByTty(tty: string, text: string): Promise<boolean> {
  const ttyPath = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // iTerm2's "write text" appends \r which Claude Code's TUI ignores.
  // Append explicit linefeed and use "newline NO" to send a proper \n.
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${ttyPath}" then
              tell s to write text "${escapedText}" newline NO
              tell s to write text ""
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
      return "not_found"
    end tell
  `;

  try {
    const result = await runAppleScript(script);
    return result === 'ok';
  } catch {
    return false;
  }
}

/**
 * Get terminal content of an iTerm2 session by matching its TTY device.
 */
export async function getSessionContentByTty(tty: string): Promise<string> {
  const ttyPath = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${ttyPath}" then
              return contents of s
            end if
          end repeat
        end repeat
      end repeat
      return ""
    end tell
  `;

  try {
    return await runAppleScript(script);
  } catch {
    return '';
  }
}

export async function focusSession(sessionId: string): Promise<void> {
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              select t
              select s
              activate
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `;

  await runAppleScript(script);
}
