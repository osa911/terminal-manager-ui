import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export class TerminalView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private onDataCallback: ((data: string) => void) | null = null;
  private onResizeCallback: ((cols: number, rows: number) => void) | null = null;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;
  }

  /**
   * Initialize terminal for a PTY-backed session (new sessions).
   * Provides full bidirectional I/O.
   */
  initInteractive(
    onData: (data: string) => void,
    onResize: (cols: number, rows: number) => void,
  ): void {
    this.destroy();

    this.onDataCallback = onData;
    this.onResizeCallback = onResize;

    this.terminal = new Terminal({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
        selectionBackground: '#364a82',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.container);

    // Fit after a short delay to allow layout
    requestAnimationFrame(() => {
      this.fit();
    });

    this.terminal.onData(onData);
    this.terminal.onResize(({ cols, rows }) => {
      onResize(cols, rows);
    });

    // Auto-resize on container change
    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.resizeObserver.observe(this.container);
  }

  /**
   * Initialize terminal for read-only content display (discovered sessions).
   * Shows iTerm2 scrollback content in a terminal emulator.
   */
  initReadOnly(): void {
    this.destroy();

    this.terminal = new Terminal({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#1a1b26', // invisible cursor
        selectionBackground: '#364a82',
      },
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: false,
      scrollback: 10000,
      disableStdin: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.container);

    requestAnimationFrame(() => {
      this.fit();
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.resizeObserver.observe(this.container);
  }

  /**
   * Write data to the terminal.
   */
  write(data: string): void {
    this.terminal?.write(data);
  }

  /**
   * Set content for read-only terminal (replaces existing content).
   */
  setContent(content: string): void {
    if (!this.terminal) return;
    this.terminal.clear();
    this.terminal.write(content.replace(/\n/g, '\r\n'));
  }

  fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      // Container might not be visible yet
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.container.innerHTML = '';
  }

  getDimensions(): { cols: number; rows: number } | null {
    if (!this.terminal) return null;
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }
}
