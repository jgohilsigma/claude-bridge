// Network interruptions, restarts, expiry and retry behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startGas, startBridge, registerSession, runHook, waitFor, pendingQuestion, chatRecord,
  addonClick, permissionEvent, tempHome,
} from './helpers/harness.js';

const click = (gas, q, act, extra = {}) => gas.chat('onCardAction', addonClick({ params: { act, q: q.id, s: q.session_id, ...extra } }));

test('network outage: questions are queued, answers given during the outage are delivered after reconnect', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas });
  try {
    const sid = await registerSession(bridge.client, 'Outage');
    await gas.offline(true);
    const hook = runHook(bridge.home, sid, permissionEvent('npm run outage'));
    const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
    const row = await waitFor(async () => (await bridge.client.get('/questions?status=PENDING')).questions.find((x) => x.id === q.id && x.push_attempts >= 1), { message: 'failed push attempt' });
    assert.equal((await bridge.client.get('/health')).chat.connected, false, 'bridge notices the outage');
    assert.equal(row.pushed_at, null, 'not pushed while offline');
    assert.ok(row.push_attempts >= 1 && row.push_error, 'push attempt recorded with error');
    await gas.offline(false);
    await chatRecord(gas, q.id); // retried push succeeds
    // PC goes offline again; the user answers on the phone in the meantime.
    await gas.offline(true);
    await waitFor(async () => (await bridge.client.get('/health')).chat.connected === false, { message: 'offline again' });
    // (Chat itself still works: only the relay endpoint used by the PC is down.)
    await click(gas, q, 'allow');
    await gas.offline(false);
    const out = await hook;
    assert.equal(out.json.hookSpecificOutput.decision.behavior, 'allow');
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('daemon restart while a hook is waiting: hook re-attaches and still gets the answer, no duplicate question', async () => {
  const gas = await startGas();
  const home = tempHome();
  let bridge = await startBridge({ gas, home });
  try {
    const sid = await registerSession(bridge.client, 'Restart');
    const hook = runHook(bridge.home, sid, permissionEvent('npm run restart'));
    const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
    await chatRecord(gas, q.id);
    await bridge.shutdown('simulated restart');
    bridge = await startBridge({ gas, home });
    // Same question, same id: the hook reconnected with its idempotency key.
    await waitFor(async () => bridge.questions.hasWaiter(q.id), { message: 'hook re-attached', timeoutMs: 15000 });
    const { questions } = await bridge.client.get('/questions?status=PENDING');
    assert.equal(questions.filter((x) => x.session_id === sid).length, 1);
    const { sessions } = await bridge.client.get('/sessions');
    assert.equal(sessions.filter((s) => s.project_name === 'Restart').length, 1, 'no duplicate session');
    await click(gas, q, 'deny');
    assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'deny');
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('expiry: unanswered question expires, hook falls back to the terminal, late answers are rejected', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas, overrides: { questionTimeoutSec: 2 } });
  try {
    const sid = await registerSession(bridge.client, 'Expiry');
    const started = Date.now();
    const hook = runHook(bridge.home, sid, permissionEvent('npm run slow'));
    const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
    await chatRecord(gas, q.id);
    const out = await hook;
    assert.equal(out.stdout, '', 'no decision → native prompt');
    assert.ok(Date.now() - started < 9000);
    await waitFor(async () => JSON.parse((await gas.state()).props[`Q_${q.id}`]).status === 'EXPIRED', { message: 'card shows expired' });
    const r = await click(gas, q, 'allow');
    assert.match(JSON.stringify(r), /Already handled|expired/i);
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('Chat API failure on push: question stays available via /pending and the push is retried by housekeeping', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas });
  try {
    await gas.failChatApi(true);
    const sid = await registerSession(bridge.client, 'PushFail');
    const hook = runHook(bridge.home, sid, permissionEvent('npm run pushfail'));
    const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
    const rec = await chatRecord(gas, q.id);
    assert.equal(rec.messageName, '');
    const row = await waitFor(async () => (await bridge.client.get('/questions?status=PENDING')).questions.find((x) => x.id === q.id && x.pushed_at), { message: 'bridge recorded push' });
    assert.match(row.push_error, /Chat API HTTP 503/);
    await gas.failChatApi(false);
    await gas.run('housekeeping');
    const after = JSON.parse((await gas.state()).props[`Q_${q.id}`]);
    assert.match(after.messageName, new RegExp(`client-${q.id}$`));
    await click(gas, q, 'allow');
    await hook;
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('bridge disconnected / reconnected notifications and unanswered reminders (housekeeping)', async () => {
  const gas = await startGas({ props: { REMIND_AFTER_MIN: '0' } });
  const bridge = await startBridge({ gas });
  try {
    const sid = await registerSession(bridge.client, 'Remind');
    const hook = runHook(bridge.home, sid, permissionEvent('npm run remind'));
    const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
    await chatRecord(gas, q.id);
    await gas.run('housekeeping');
    let pushes = (await gas.state()).pushes.map((p) => p.msg.text || '');
    assert.ok(pushes.some((t) => t.includes('Still waiting for you') && t.includes(q.id)), 'reminder sent');
    // Simulate the PC being silent for 10 minutes.
    await gas.offline(true);
    const st = await gas.state();
    const b = JSON.parse(st.props.BRIDGE);
    await gas.setProps({ BRIDGE: JSON.stringify({ ...b, lastSeenAt: Date.now() - 10 * 60000 }) });
    await gas.run('housekeeping');
    pushes = (await gas.state()).pushes.map((p) => p.msg.text || '');
    assert.ok(pushes.some((t) => t.includes('Bridge disconnected')));
    await gas.offline(false);
    await waitFor(async () => (await gas.state()).pushes.some((p) => (p.msg.text || '').includes('Bridge reconnected')), { message: 'reconnected notice' });
    await click(gas, q, 'deny');
    await hook;
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('webhook push mode (no service account): text notification with /reply instructions', async () => {
  const gas = await startGas({ props: { SERVICE_ACCOUNT_JSON: '', PUSH_MODE: 'webhook', WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/WEBHOOK/messages?key=k&token=t' } });
  const bridge = await startBridge({ gas });
  try {
    const sid = await registerSession(bridge.client, 'Webhook');
    const hook = runHook(bridge.home, sid, permissionEvent('npm run webhook'));
    const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
    await chatRecord(gas, q.id);
    const w = await waitFor(async () => (await gas.state()).pushes.find((p) => p.kind === 'webhook'), { message: 'webhook push' });
    assert.match(w.msg.text, new RegExp(`/reply ${q.id} allow`));
    assert.match(w.msg.text, /npm run webhook/);
    await click(gas, q, 'allow');
    assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('session exit notifications: completed and failed', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas });
  try {
    const ok = await registerSession(bridge.client, 'Done OK');
    const bad = await registerSession(bridge.client, 'Done Bad');
    await bridge.client.post(`/runner/${ok}/exit`, { exitCode: 0 });
    await bridge.client.post(`/runner/${bad}/exit`, { exitCode: 2 });
    await waitFor(async () => {
      const texts = (await gas.state()).pushes.map((p) => p.msg.text || '');
      return texts.some((t) => t.includes('Session completed') && t.includes('Done OK')) && texts.some((t) => t.includes('Session failed') && t.includes('Done Bad'));
    }, { message: 'exit notifications' });
    const { sessions } = await bridge.client.get('/sessions');
    assert.equal(sessions.find((s) => s.id === ok).display_status, 'COMPLETED');
    assert.equal(sessions.find((s) => s.id === bad).display_status, 'FAILED');
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});

test('bad shared secret: relay refuses the bridge and nothing is stored', async () => {
  const gas = await startGas();
  const bridge = await startBridge({ gas, overrides: { sharedSecret: 'wrong-secret-wrong-secret-wrong-secret-xx' } });
  try {
    await waitFor(async () => /bad signature/.test((await bridge.client.get('/health')).chat.lastError || ''), { message: 'auth error surfaced' });
    const audit = (await gas.state()).sheets.Audit || [];
    assert.ok(audit.some((r) => r[2] === 'relay.auth_rejected'));
  } finally {
    await bridge.shutdown('test');
    await gas.stop();
  }
});
