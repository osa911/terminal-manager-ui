# Terminal Manager UI

A web dashboard for monitoring and managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) terminal sessions. Built for developers who run several Claude Code instances and need visibility into what each session is doing.

![Status](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)

## Features

- **Cross-Platform** — works on macOS (any terminal) and Linux; full feature set with iTerm2, graceful fallback without
- **Session Discovery** — automatically finds running Claude Code processes, matches them with iTerm2 tabs (when available), and locates JSONL transcript files
- **Live Status** — real-time active/idle/attention indicators based on JSONL file activity
- **Chat View** — renders Claude Code conversation history with markdown support (headers, code blocks, tables, lists, links)
- **Attention Detection** — detects when a session needs user input (permission prompts, confirmation dialogs, questions) and sends browser notifications
- **Interactive Questions** — renders `AskUserQuestion` prompts as clickable option buttons
- **New Sessions** — spawn new Claude Code sessions with an interactive terminal (xterm.js) via a folder browser
- **Session Management** — resume terminated sessions, rename sessions, terminate running ones
- **Sharing** — generate share links for read-only or interactive access to a session
- **Password Auth** — simple password gate to protect the dashboard
- **Mobile Friendly** — responsive layout with bottom-sheet modals and safe area support
- **Themes** — dark and light mode

## Architecture

```
Browser (localhost:3456)
├── Dashboard (session list with status dots)
├── Chat View (parsed JSONL → markdown messages)
└── Terminal View (xterm.js for spawned sessions)
        │
    WebSocket
        │
Node.js Server
├── Terminal Bridge (ItermBridge or GenericBridge — platform-detected)
├── JSONL Watcher (chokidar — ~/.claude/projects/*/*.jsonl)
├── Attention Detector (hooks + CPU + terminal content)
└── PTY Manager (node-pty — spawn new Claude processes)
```

## Requirements

- **macOS** or **Linux**
- **Node.js** >= 20
- **Claude Code CLI** installed
- **iTerm2** (optional, macOS only — enables terminal content reading and richer status detection)

## Quick Start

```bash
# Install dependencies
npm install

# Configure password
cp .env.example .env
# Edit .env and set your password

# Build client + server
npm run build

# Start the server
npm start
```

Open [http://localhost:3456](http://localhost:3456) and enter your password.

### Development

```bash
# Build and start in one step
npm run dev

# Or build parts separately
npm run build:client   # esbuild bundles src/client → dist/public
npm run build:server   # tsc compiles src/server → dist/server
```

### Configuration

Copy the example env file and set your values:

```bash
cp .env.example .env
```

Edit `.env` to configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `TM_PASSWORD` | `admin` | Password for the login page |
| `TM_DEFAULT_CWD` | `~` | Default directory for the "New Session" folder browser. Set this to your project root so new Claude sessions start in the right place. |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to the Claude Code CLI binary (useful if installed elsewhere) |
| `PORT` | `3456` | Server port (hardcoded, change in `src/server/index.ts`) |

Example `.env`:

```bash
TM_PASSWORD=mysecretpassword
TM_DEFAULT_CWD=/home/user/my-project
```

## Project Structure

```
src/
├── server/
│   ├── index.ts                # Express + WebSocket server
│   ├── platform.ts             # Detect darwin-iterm / darwin / linux
│   ├── terminal-bridge.ts      # TerminalBridge interface + factory
│   ├── iterm-bridge.ts         # iTerm2 AppleScript bridge (macOS)
│   ├── generic-bridge.ts       # Cross-platform fallback (TTY write)
│   ├── session-discovery.ts    # Find running Claude processes
│   ├── jsonl-watcher.ts        # Watch & parse JSONL transcripts
│   ├── attention-detector.ts   # Detect sessions needing input
│   ├── pty-manager.ts          # Spawn new Claude sessions
│   └── types.ts                # Shared TypeScript types
├── client/
│   ├── index.html              # Dashboard page
│   ├── login.html              # Login page
│   ├── app.ts                  # UI controller + WebSocket client
│   ├── chat-view.ts            # Markdown chat renderer
│   ├── terminal-view.ts        # xterm.js terminal
│   └── styles.css              # All styles
├── build.js                    # esbuild script for client bundling
├── tsconfig.json
└── package.json
```

## Cross-Platform Support

The server detects the platform at startup and selects the appropriate terminal bridge:

| Feature | macOS + iTerm2 | macOS (other terminal) | Linux |
|---------|---------------|----------------------|-------|
| Session discovery | `ps` + iTerm2 | `ps` only | `ps` + `/proc` |
| Status detection | hooks + CPU + terminal content | hooks + CPU | hooks + CPU |
| Status text (e.g. "Compacting...") | from terminal | n/a | n/a |
| Send input to sessions | iTerm2 AppleScript | direct TTY write | direct TTY write |
| Chat view (JSONL) | yes | yes | yes |
| Spawned sessions (PTY) | yes | yes | yes |

The startup log shows which bridge was selected:

```
Platform: darwin-iterm, bridge: ItermBridge
```

## Remote Access

The dashboard runs on `localhost:3456` by default. To expose it to the public internet, you can use [GiraffeCloud](https://giraffecloud.xyz) to create a secure tunnel:

1. Sign up at https://giraffecloud.xyz and configure your tunnel in the dashboard (set local port to `3456`)
2. Install the GiraffeCloud client following the [getting started guide](https://giraffecloud.xyz/dashboard/getting-started)
3. Connect:

```bash
giraffecloud connect
```

This gives you a public URL that tunnels back to your local Terminal Manager.

Alternatively, use any tunnel tool:

```bash
# SSH tunnel
ssh -R 3456:localhost:3456 your-server

# Or ngrok, cloudflared, etc.
```

Once exposed, use the **Share** button in the dashboard to generate share links. Share links provide read-only or interactive access to a specific session without requiring the dashboard password.

## Screenshots

main UI
<img width="1892" height="2078" alt="CleanShot 2026-03-03 at 12 29 05@2x" src="https://github.com/user-attachments/assets/cc1c823d-16c1-491a-a660-acaaa3df0e39" />

questions from AI
<img width="1582" height="846" alt="CleanShot 2026-03-03 at 10 28 58@2x" src="https://github.com/user-attachments/assets/a0429650-7539-440f-9d91-6238ca4af712" />


## License

MIT
