// Writes answers into a PTY. Every injection is preceded by a verification callback so that we
// never type into a terminal that is no longer showing the prompt the answer was meant for.
import { sleep } from '../util/ids.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export class InputInjector {
  constructor(write, { keyDelayMs = 40, logger } = {}) {
    this.write = write;
    this.keyDelayMs = keyDelayMs;
    this.logger = logger;
    this.busy = Promise.resolve();
  }

  /** Serializes injections so two answers can never interleave keystrokes. */
  run(fn) {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  /** Sends a sequence of key chunks (e.g. arrows then Enter) after verify() returns true. */
  sendKeys(keys, verify = () => true) {
    return this.run(async () => {
      const v = await verify();
      if (v !== true) throw new Error(typeof v === 'string' ? v : 'verification failed: prompt is no longer on screen');
      for (const k of keys) {
        this.write(k);
        await sleep(this.keyDelayMs);
      }
    });
  }

  /**
   * Types free text into an input box and submits it. Multi-line text uses bracketed paste so the
   * embedded newlines are not interpreted as Enter.
   */
  sendText(text, verify = () => true) {
    return this.run(async () => {
      const v = await verify();
      if (v !== true) throw new Error(typeof v === 'string' ? v : 'verification failed');
      if (text.includes('\n')) this.write(BRACKETED_PASTE_START + text + BRACKETED_PASTE_END);
      else this.write(text);
      await sleep(Math.min(600, 120 + text.length / 4));
      this.write('\r');
    });
  }
}
