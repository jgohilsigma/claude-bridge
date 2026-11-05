// Virtual terminal screen (xterm.js headless) fed with the PTY output, so prompt detection works
// on what is actually visible rather than on raw escape-sequence streams.
import xterm from '@xterm/headless';

export class VirtualScreen {
  constructor(cols = 120, rows = 40) {
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 500 });
  }

  write(data) {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols, rows) {
    this.term.resize(Math.max(20, cols), Math.max(5, rows));
  }

  /** Visible rows (trailing whitespace trimmed) plus the cursor position within them. */
  snapshot() {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < this.term.rows; i++) {
      lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
    }
    return { lines, cursorRow: buf.cursorY + buf.baseY - buf.viewportY, cursorCol: buf.cursorX };
  }

  text() {
    return this.snapshot().lines.join('\n');
  }

  dispose() {
    this.term.dispose();
  }
}
