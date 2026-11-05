import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPrompt } from '../src/terminal/prompt-detector.js';
import { VirtualScreen } from '../src/terminal/screen.js';

const fixture = (n) => ({ lines: fs.readFileSync(new URL(`./fixtures/${n}.txt`, import.meta.url), 'utf8').split('\n') });

test("Claude Code's numbered permission dialog (captured from v2.1.280)", () => {
  const p = detectPrompt(fixture('claude-permission'));
  assert.equal(p.kind, 'menu');
  assert.equal(p.numbered, true);
  assert.equal(p.cursorIndex, 0);
  assert.deepEqual(p.options.map((o) => o.label.slice(0, 20)), ['Yes', 'Yes, and always allo', 'No']);
  assert.match(p.question, /Do you want to proceed\?/);
});

test("Claude Code's unnumbered folder-trust dialog", () => {
  const p = detectPrompt(fixture('claude-trust'));
  assert.equal(p.kind, 'menu');
  assert.equal(p.numbered, false);
  assert.deepEqual(p.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.equal(p.cursorIndex, 0);
});

test('idle Claude prompt and numbered lists in the transcript are not prompts', () => {
  assert.equal(detectPrompt(fixture('claude-idle')), null);
});

test('yes/no confirmations', () => {
  const p = detectPrompt({ lines: ['Removing 3 files', 'Continue? [y/N] '] });
  assert.equal(p.kind, 'yes_no');
  assert.equal(p.options[1].label, 'No (default)');
});

test('inquirer-style list with arrow-key hint, cursor not on first item', () => {
  const p = detectPrompt({ lines: ['? Pick a framework: (Use arrow keys)', '  React', '❯ Vue', '  Svelte'] });
  assert.equal(p.kind, 'menu');
  assert.equal(p.cursorIndex, 1);
  assert.deepEqual(p.options.map((o) => o.label), ['React', 'Vue', 'Svelte']);
});

test('fingerprint ignores cursor position but changes with content', () => {
  const a = detectPrompt({ lines: ['? Pick: (Use arrow keys)', '❯ A', '  B'] });
  const b = detectPrompt({ lines: ['? Pick: (Use arrow keys)', '  A', '❯ B'] });
  const c = detectPrompt({ lines: ['? Pick: (Use arrow keys)', '❯ A', '  C'] });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('text prompts only when enabled and the cursor sits at the end', () => {
  const snap = { lines: ['Project name: '], cursorRow: 0, cursorCol: 14 };
  assert.equal(detectPrompt(snap), null);
  assert.equal(detectPrompt(snap, { textPrompts: true }).kind, 'text_prompt');
  assert.equal(detectPrompt({ lines: ['user@host:~$ '], cursorRow: 0, cursorCol: 13 }, { textPrompts: true }), null);
});

test('virtual screen renders escape sequences before detection', async () => {
  const s = new VirtualScreen(80, 10);
  await s.write('\x1b[2J\x1b[HSelect env:\r\n\x1b[36m❯ staging\x1b[0m\r\n  production\r\n\r\nEnter to confirm');
  const p = detectPrompt(s.snapshot());
  assert.deepEqual(p.options.map((o) => o.label), ['staging', 'production']);
  s.dispose();
});

test('an old menu followed by new output is not a prompt any more', () => {
  const lines = ['? Choose target: (Use arrow keys)', '  staging', '❯ production', '  local', '', 'SELECTED: production', '', 'Proceed with cleanup? [y/N] '];
  const p = detectPrompt({ lines });
  assert.equal(p.kind, 'yes_no');
  assert.equal(detectPrompt({ lines: lines.slice(0, 6) }), null);
});
