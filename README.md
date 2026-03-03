# Terminal Manager UI

A web dashboard for monitoring and managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) terminal sessions. Built for developers who run several Claude Code instances across iTerm2 tabs and need visibility into what each session is doing.

![Status](https://img.shields.io/badge/platform-macOS-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)

## Features

- **Session Discovery** — automatically finds running Claude Code processes and matches them with iTerm2 tabs and JSONL transcript files
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
├── iTerm2 Bridge (AppleScript — enumerate, read, write)
├── JSONL Watcher (chokidar — ~/.claude/projects/*/*.jsonl)
├── Attention Detector (periodic mtime check + terminal pattern matching)
└── PTY Manager (node-pty — spawn new Claude processes)
```

## Requirements

- **macOS** (uses iTerm2 AppleScript integration)
- **Node.js** >= 20
- **iTerm2** (for existing session discovery)
- **Claude Code CLI** installed

## Quick Start

```bash
# Install dependencies
npm install

# Build client + server
npm run build

# Start the server
TM_PASSWORD=yourpassword npm start
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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TM_PASSWORD` | `admin` | Password for the login page |
| `PORT` | `3456` | Server port (hardcoded, change in `src/server/index.ts`) |

## Project Structure

```
src/
├── server/
│   ├── index.ts                # Express + WebSocket server
│   ├── session-discovery.ts    # Find running Claude processes
│   ├── iterm-bridge.ts         # iTerm2 AppleScript integration
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

Questions from AI
<img width="1582" height="846" alt="CleanShot 2026-03-03 at 10 28 58@2x" src="https://github.com/user-attachments/assets/a0429650-7539-440f-9d91-6238ca4af712" />


## License

MIT
