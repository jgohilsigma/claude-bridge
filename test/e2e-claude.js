#!/usr/bin/env node
// End-to-end run against the REAL Claude Code CLI (uses a few Haiku tokens):
//   bridge start → folder-trust dialog (PTY menu) → AskUserQuestion (hook) → Bash permission (hook)
//   → "turn finished" free-text reply typed back into Claude → Claude continues.
// Every answer is given by simulating Google Chat button clicks against the real Code.gs.
//
// Usage: npm run test:e2e-claude   (set E2E_SESSIONS=2 to run two Claude sessions concurrently)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGas, startBridge, waitFor, chatRecord, addonClick, formText, ROOT } from './helpers/harness.js';
import { spawnPty } from '../src/terminal/pty-manager.js';

const N = Number(process.env.E2E_SESSIONS || 2);
// E2E_PERMISSION_MODE=inherit runs Claude with your own default permission mode (e.g. "auto").
const MODE = process.env.E2E_PERMISSION_MODE || 'default';
const modeArgs = MODE === 'inherit' ? [] : ['--permission-mode', MODE];
// E2E_MODEL=inherit uses your default model (auto mode is not offered for every model).
const modelArgs = process.env.E2E_MODEL === 'inherit' ? [] : ['--model', process.env.E2E_MODEL || 'haiku'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const gas = await startGas();
const bridge = await startBridge({ gas, overrides: { questionTimeoutSec: 600, sessionStaleSec: 60 } });
log('simulated Apps Script at', gas.url, '| daemon pid', process.pid);

const click = (q, params, opts = {}) => gas.chat('onCardAction', addonClick({ params: { q: q.id, s: q.session_id, ...params }, ...opts }));
const nextQuestion = (sid, kind, timeoutMs = 120000) =>
  waitFor(async () => (await bridge.client.get('/questions?status=PENDING')).questions.find((q) => q.session_id === sid && (!kind || q.kind === kind)), { timeoutMs, intervalMs: 250, message: `${kind} question for ${sid}` });

async function runOne(i) {
  const name = ['alpha', 'beta'][i % 2];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccb-e2e-${i}-`));
  const prompt = `Do exactly these steps. 1) Use the AskUserQuestion tool to ask me which file name to use, options "alpha.txt" and "beta.txt". 2) Use the Bash tool to run: echo hello-${i} > <chosen name>. 3) Then ask me in plain text whether you should also create a README, and stop.`;
  let output = '';
  const pty = spawnPty(process.execPath, [path.join(ROOT, 'bin', 'bridge.js'), 'start', `E2E Project ${i + 1}`, '--cwd', dir, '--new', '--', ...modelArgs, ...modeArgs, prompt], {
    cwd: dir, cols: 120, rows: 40, env: { ...process.env, BRIDGE_HOME: bridge.home, BRIDGE_NO_AUTOSTART: '1' },
  });
  pty.onData((d) => (output += d));
  const exited = new Promise((r) => pty.onExit(r));
  const sid = await waitFor(async () => (await bridge.client.get('/sessions')).sessions.find((s) => s.project_name === `E2E Project ${i + 1}`)?.id, { message: 'session registered' });
  log(`[${sid}] started in ${dir}`);

  const steps = [];
  for (let guard = 0; guard < 10; guard++) {
    const q = await nextQuestion(sid);
    await chatRecord(gas, q.id);
    if (q.kind === 'menu' && /trust/i.test(q.question + q.options.map((o) => o.label).join())) {
      const idx = q.options.findIndex((o) => /yes, i trust/i.test(o.label));
      log(`[${sid}] ${q.id} trust dialog (PTY menu) → click "${q.options[idx].label}"`);
      await click(q, { act: 'opt', i: idx });
      steps.push('trust');
    } else if (q.kind === 'ask_user_question') {
      const idx = q.options.findIndex((o) => o.label.startsWith(name));
      log(`[${sid}] ${q.id} AskUserQuestion "${q.question}" → click "${q.options[idx].label}"`);
      await click(q, { act: 'opt', i: idx });
      steps.push('ask');
    } else if (q.kind === 'permission') {
      log(`[${sid}] ${q.id} permission ${q.payload.toolName}: ${q.payload.summary} → Allow`);
      await click(q, { act: q.payload.dangerous ? 'allowConfirm' : 'allow' });
      steps.push('permission');
    } else if (q.kind === 'free_text' && !steps.includes('reply')) {
      log(`[${sid}] ${q.id} turn finished: "${q.question.replace(/\s+/g, ' ').slice(0, 120)}" options=${JSON.stringify(q.options.map((o) => o.label))}`);
      await click(q, { act: 'text' });
      await click(q, { act: 'submitText' }, { form: { answer: formText(`No README. Reply with exactly: E2E-DONE-${i}`) }, dialog: true });
      steps.push('reply');
    } else if (q.kind === 'free_text') {
      log(`[${sid}] ${q.id} final turn: "${q.question.slice(0, 80)}"`);
      break;
    } else {
      log(`[${sid}] unexpected question`, q.kind, q.question.slice(0, 200));
      await click(q, { act: 'cancel' });
    }
    const done = await waitFor(async () => {
      const all = (await bridge.client.get('/questions?limit=200')).questions;
      const x = all.find((y) => y.id === q.id);
      return x && x.status !== 'PENDING' && x.status !== 'ANSWERED' ? x : null;
    }, { timeoutMs: 60000, intervalMs: 200, message: `answer for ${q.id} processed` });
    log(`[${sid}] ${q.id} → ${done.status}${done.resolution_note ? ` (${done.resolution_note})` : ''}`);
  }
  await waitFor(() => output.includes(`E2E-DONE-${i}`), { timeoutMs: 120000, message: 'Claude acknowledged the typed reply' });
  const modes = [...new Set([...output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').matchAll(/(auto|manual|accept edits|plan|bypass permissions) mode on/gi)].map((m) => m[1].toLowerCase()))];
  log(`[${sid}] permission mode shown by Claude: ${modes.join(', ') || 'unknown'}`);
  const file = path.join(dir, `${name}.txt`);
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  pty.write('/exit\r');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  pty.kill();
  return { sid, steps, file, content, expected: `hello-${i}` };
}

let failed = false;
try {
  const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));
  for (const r of results) {
    // In auto mode the classifier may approve the Bash call itself, so no permission question appears.
    const required = MODE === 'default' ? ['ask', 'permission', 'reply'] : ['ask', 'reply'];
    const ok = r.content === r.expected && required.every((s) => r.steps.includes(s));
    failed ||= !ok;
    log(`${ok ? 'PASS' : 'FAIL'} ${r.sid}: steps=${r.steps.join(' → ')} file=${path.basename(r.file)} content=${JSON.stringify(r.content)}`);
  }
  const { questions } = await bridge.client.get('/questions?limit=50');
  log('question history:');
  for (const q of questions.reverse()) log(`  ${q.id} ${q.session_id} ${q.kind.padEnd(18)} ${q.status.padEnd(16)} ${q.answer?.summary || q.resolution_note || ''}`);
} catch (err) {
  failed = true;
  console.error('E2E FAILED:', err.message);
} finally {
  await bridge.shutdown('e2e done');
  await gas.stop();
}
process.exit(failed ? 1 : 0);
