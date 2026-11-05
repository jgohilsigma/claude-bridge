import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUserKeystroke } from '../src/terminal/runner.js';

test('focus changes, mouse and terminal replies are not keystrokes (no accidental takeover)', () => {
  for (const s of ['\x1b[I', '\x1b[O', '\x1b[O\x1b[I', '\x1b[<0;12;5M', '\x1b[<0;12;5m', '\x1b[M !!', '\x1b[24;80R', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x07']) {
    assert.equal(isUserKeystroke(s), false, JSON.stringify(s));
  }
  for (const s of ['a', '1', '\r', '\x1b[A', '\x1b[B', '\x7f', 'hello', '\x1c']) assert.equal(isUserKeystroke(s), true, JSON.stringify(s));
});
