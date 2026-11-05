// Session runner (bridge start) with a real PTY: prompts detected on screen are answered from Chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startGas, startBridge, waitFor, chatRecord, addonClick, ROOT } from './helpers/harness.js';
import { spawnPty } from '../src/terminal/pty-manager.js';

function startRunner(home, project, extraArgs = []) {
  let output = '';
  const pty = spawnPty(process.execPath, [path.join(ROOT, 'bin', 'bridge.js'), 'start', project, '--cmd', process.execPath, '--new', ...extraArgs, '--', path.join(ROOT, 'test', 'fixtures', 'fake-cli.js')], {
    cwd: ROOT,
    cols: 100,
    rows: 30,
    env: { ...process.env, BRIDGE_HOME: home, BRIDGE_NO_AUTOSTART: '1' },
  });
  pty.onData((d) => (output += d));
  const exited = new Promise((resolve) => pty.onExit(resolve));
  return { pty, exited, output: () => output };
}

const pending = async (client, sid, kind) =>
  waitFor(async () => (await client.get('/questions?status=PENDING')).questions.find((q) => (!sid || q.session_id === sid) && q.kind === kind), { message: `${kind} question`, timeoutMs: 15000 });

test('menu and y/N prompts in a PTY are answered from Google Chat', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas });
  const r = startRunner(bridge.home, 'Fake Deploy');
  try {
    const menu = await pending(bridge.client, null, 'menu');
    assert.deepEqual(menu.options.map((o) => o.label), ['staging', 'production', 'local']);
    assert.match(menu.question, /Choose deployment target/);
    await chatRecord(gas, menu.id);
    await gas.chat('onCardAction', addonClick({ params: { act: 'opt', q: menu.id, s: menu.session_id, i: 1 } }));
    await waitFor(() => r.output().includes('SELECTED: production'), { message: 'menu selection typed', timeoutMs: 15000 });

    const yn = await pending(bridge.client, menu.session_id, 'yes_no');
    assert.match(yn.question, /Proceed with cleanup/);
    await chatRecord(gas, yn.id);
    await gas.chat('onCardAction', addonClick({ params: { act: 'opt', q: yn.id, s: yn.session_id, i: 0 } }));
    await waitFor(() => r.output().includes('ANSWER: y'), { message: 'y typed', timeoutMs: 15000 });
    const exit = await r.exited;
    assert.equal(exit.exitCode, 0);
    await waitFor(async () => (await bridge.client.get('/sessions')).sessions.find((s) => s.id === menu.session_id).status === 'COMPLETED', { message: 'session completed' });
    const { questions } = await bridge.client.get('/questions?status=DELIVERED');
    assert.ok([menu.id, yn.id].every((id) => questions.some((q) => q.id === id)));
  } finally {
    r.pty.kill();
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('answer is refused when the prompt was already answered at the keyboard', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas });
  const r = startRunner(bridge.home, 'Local First');
  try {
    const menu = await pending(bridge.client, null, 'menu');
    await chatRecord(gas, menu.id);
    r.pty.write('\r'); // person at the keyboard picks "staging"
    await waitFor(() => r.output().includes('SELECTED: staging'), { message: 'local selection' });
    await waitFor(async () => (await bridge.client.get('/questions?status=ANSWERED_LOCALLY')).questions.some((q) => q.id === menu.id), { message: 'answered locally', timeoutMs: 15000 });
    // The click may land before or after the "answered locally" status reaches Chat; either way the
    // bridge must refuse it and nothing may be typed.
    await gas.chat('onCardAction', addonClick({ params: { act: 'opt', q: menu.id, s: menu.session_id, i: 2 } }));
    const rec = await waitFor(async () => {
      const x = JSON.parse((await gas.state()).props[`Q_${menu.id}`]);
      return x.status === 'ANSWERED_LOCALLY' ? x : null;
    }, { message: 'card resolved as answered locally' });
    const { entries } = await bridge.client.get('/audit?limit=50');
    const rejected = entries.find((e) => e.question_id === menu.id && e.action === 'response.rejected');
    if (rejected) assert.match(rejected.detail.reason, /no longer pending/);
    assert.ok(rec);
    assert.ok(!r.output().includes('SELECTED: local'), 'stale answer must not be typed');
    r.pty.write('n\r');
    await r.exited;
  } finally {
    r.pty.kill();
    await bridge.shutdown('test');
    await gas.stop();
  }
});
