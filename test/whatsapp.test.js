// WhatsApp channel (linked-device mode) together with the email relay: BRIDGE_CHANNELS=gmail,whatsapp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGas, startBridge, registerSession, runHook, waitFor, pendingQuestion, chatRecord, permissionEvent, askEvent, tempHome, OWNER } from './helpers/harness.js';
import { createFakeWhatsApp, linkedHome, MY_JID } from './helpers/fake-whatsapp.js';

let gas;
let bridge;
let wa;

before(async () => {
  gas = await startGas({ props: { SERVICE_ACCOUNT_JSON: '', CHAT_SPACE: '' } }); // gmail mode
  wa = createFakeWhatsApp();
  bridge = await startBridge({ gas, home: linkedHome(tempHome()), env: { BRIDGE_CHANNELS: 'gmail,whatsapp' }, whatsappLoader: wa.loader });
  await waitFor(() => bridge.whatsapp.conn.state === 'connected', { message: 'whatsapp connected' });
});

after(async () => {
  await bridge?.shutdown('done');
  await gas?.stop();
});

/** The WhatsApp message (and its key) sent for a question. */
const waQuestion = (qid) =>
  waitFor(() => wa.sent.find((s) => s.content.text?.includes(` · ${qid}`) && !s.content.edit), { message: `whatsapp message for ${qid}` });

test('linking sends a welcome message to your own chat', async () => {
  await waitFor(() => wa.texts().some((t) => t.includes('Claude Assistant is connected to WhatsApp')), { message: 'welcome' });
  assert.equal(wa.sent[0].jid, MY_JID);
});

test('a question goes to BOTH email and WhatsApp; a WhatsApp reply answers it and the email side shows it', async () => {
  const sid = await registerSession(bridge.client, 'WA Both');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run deploy:staging'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const msg = await waQuestion(q.id);
  await chatRecord(gas, q.id); // also emailed
  assert.match(msg.content.text, /Permission request/);
  assert.match(msg.content.text, /📂 \*WA Both\*/);
  assert.match(msg.content.text, /```npm run deploy:staging```/);
  wa.userSays('deny use the CI pipeline instead', { quote: msg.key });
  const out = await hook;
  assert.equal(out.json.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.json.hookSpecificOutput.decision.message, /use the CI pipeline instead by whatsapp:\+919000000001/);
  await waitFor(() => wa.reactions().some((r) => r.emoji === '✅'), { message: '✅ reaction' });
  await waitFor(async () => JSON.parse((await gas.state()).props[`Q_${q.id}`]).status === 'DELIVERED', { message: 'email side updated' });
  await waitFor(() => wa.edits().some((e) => e.id === msg.key.id && /✅ Answered/.test(e.text)), { message: 'whatsapp message edited' });
});

test('first answer wins: answered by email first → WhatsApp message edited, late WhatsApp reply refused', async () => {
  const sid = await registerSession(bridge.client, 'WA Race');
  const hook = runHook(bridge.home, sid, askEvent([{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'MySQL' }] }]));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const msg = await waQuestion(q.id);
  const t = await waitFor(async () => (await gas.state()).gmail.find((x) => x.messages[0].subject.endsWith(`(${q.id})`)), { message: 'email' });
  await gas.gmailInject({ threadId: t.id, body: '1', from: OWNER, sent: true });
  await gas.run('gmailPoll');
  assert.equal((await hook).json.hookSpecificOutput.updatedInput.answers['Which DB?'], 'Postgres');
  await waitFor(() => wa.edits().some((e) => e.id === msg.key.id && /✅ Answered\*: Postgres _\(via email\)_/.test(e.text)), { message: 'edit shows answer' });
  wa.userSays('2', { quote: msg.key });
  await waitFor(() => wa.texts().some((x) => /already handled[\s\S]*not\* sent to Claude/.test(x)), { message: 'late reply explained' });
});

test('plain reply goes to the only open question; with several open, you are asked to quote or use the id', async () => {
  const a = await registerSession(bridge.client, 'WA One');
  const hookA = runHook(bridge.home, a, askEvent([{ question: 'Color?', header: 'C', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }]));
  const qa = await pendingQuestion(bridge.client, (x) => x.session_id === a);
  await waQuestion(qa.id);
  const b = await registerSession(bridge.client, 'WA Two');
  const hookB = runHook(bridge.home, b, askEvent([{ question: 'Size?', header: 'S', multiSelect: false, options: [{ label: 'S' }, { label: 'L' }] }]));
  const qb = await pendingQuestion(bridge.client, (x) => x.session_id === b);
  await waQuestion(qb.id);
  wa.userSays('2');
  await waitFor(() => wa.texts().some((x) => /2 questions are waiting/.test(x)), { message: 'ambiguity explained' });
  wa.userSays(`${qb.id} 2`);
  assert.equal((await hookB).json.hookSpecificOutput.updatedInput.answers['Size?'], 'L');
  wa.userSays('Green, actually');
  assert.equal((await hookA).json.hookSpecificOutput.updatedInput.answers['Color?'], 'Green, actually');
});

test('security: messages from other chats, old history and the bot\'s own echoes are ignored', async () => {
  const sid = await registerSession(bridge.client, 'WA Sec');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run sec'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const msg = await waQuestion(q.id);
  wa.userSays('allow', { quote: msg.key, chat: '15550001111@s.whatsapp.net', fromMe: false }); // a stranger
  wa.userSays('allow', { quote: msg.key, ageSec: 3600 }); // old history sync
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await bridge.client.get('/questions?status=PENDING')).questions.some((x) => x.id === q.id), true, 'still pending');
  wa.userSays('allow', { quote: msg.key });
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
});

test('sensitive permission needs "allow confirm"', async () => {
  const sid = await registerSession(bridge.client, 'WA Danger');
  const hook = runHook(bridge.home, sid, permissionEvent('rm -rf build'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const msg = await waQuestion(q.id);
  assert.match(msg.content.text, /Sensitive operation/);
  wa.userSays('allow', { quote: msg.key });
  await waitFor(() => wa.texts().some((x) => /reply \*allow confirm\*/.test(x)), { message: 'confirm requested' });
  wa.userSays('allow confirm', { quote: msg.key });
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
});

test('multi-question: one line per question; multi-select with "1,3"', async () => {
  const sid = await registerSession(bridge.client, 'WA Multi');
  const hook = runHook(bridge.home, sid, askEvent([
    { question: 'Features?', header: 'F', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }] },
    { question: 'Ship?', header: 'S', multiSelect: false, options: [{ label: 'Now' }, { label: 'Later' }] },
  ]));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const msg = await waQuestion(q.id);
  assert.match(msg.content.text, /one line per question/);
  wa.userSays('1,3\nnext Monday', { quote: msg.key });
  assert.deepEqual((await hook).json.hookSpecificOutput.updatedInput.answers, { 'Features?': 'Auth, Search', 'Ship?': 'next Monday' });
});

test('finished task message with context; reply is typed into Claude', async () => {
  const sid = await registerSession(bridge.client, 'WA Done');
  await runHook(bridge.home, sid, { hook_event_name: 'Stop', last_assistant_message: 'Added **validation**. All tests pass.' });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid && x.kind === 'free_text');
  const msg = await waQuestion(q.id);
  assert.match(msg.content.text, /✅ \*Task finished\*/);
  assert.match(msg.content.text, /Added \*validation\*/);
  const typed = (async () => {
    for (;;) {
      const { commands } = await bridge.client.get(`/runner/${sid}/commands?wait=5`, { timeoutMs: 10000 });
      const c = commands.find((x) => x.type === 'text');
      if (c) {
        await bridge.client.post(`/runner/${sid}/command-result`, { id: c.id, ok: true });
        return c.text;
      }
    }
  })();
  wa.userSays('Now update the README', { quote: msg.key });
  assert.equal(await typed, 'Now update the README');
});

test('commands and notifications', async () => {
  wa.userSays('sessions');
  await waitFor(() => wa.texts().some((x) => /^\u2063\u2063\*Sessions\*/.test(x) && /WA Done/.test(x)), { message: 'sessions reply' });
  wa.userSays('help');
  await waitFor(() => wa.texts().some((x) => /Claude Assistant on WhatsApp/.test(x)), { message: 'help reply' });
  const sid = await registerSession(bridge.client, 'WA Exit');
  await bridge.client.post(`/runner/${sid}/exit`, { exitCode: 1 });
  await waitFor(() => wa.texts().some((x) => /Session failed/.test(x) && /WA Exit/.test(x)), { message: 'failure notification on whatsapp' });
});

test('WhatsApp only (no email): BRIDGE_CHANNELS=whatsapp needs no Apps Script', async () => {
  const wa2 = createFakeWhatsApp();
  const b2 = await startBridge({ home: linkedHome(tempHome()), env: { BRIDGE_CHANNELS: 'whatsapp', BRIDGE_APPS_SCRIPT_URL: '' }, whatsappLoader: wa2.loader });
  try {
    await waitFor(() => b2.whatsapp.conn.state === 'connected', { message: 'connected' });
    assert.equal(b2.cfg.useRelay, false);
    const sid = await registerSession(b2.client, 'WA Solo');
    const hook = runHook(b2.home, sid, permissionEvent('npm test'));
    const q = await pendingQuestion(b2.client, (x) => x.session_id === sid);
    const msg = await waitFor(() => wa2.sent.find((s) => s.content.text?.includes(q.id)), { message: 'sent' });
    wa2.userSays('allow', { quote: msg.key });
    assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
  } finally {
    await b2.shutdown('done');
  }
});

test('several numbers in BRIDGE_WHATSAPP_TO: each gets the question, any may answer, all copies are updated', async () => {
  const A = '919811111111';
  const B = '919822222222';
  const jidA = `${A}@s.whatsapp.net`;
  const jidB = `${B}@s.whatsapp.net`;
  const wa3 = createFakeWhatsApp();
  const b3 = await startBridge({ home: linkedHome(tempHome()), env: { BRIDGE_CHANNELS: 'whatsapp', BRIDGE_APPS_SCRIPT_URL: '', BRIDGE_WHATSAPP_TO: `+91 98111 11111, ${B}` }, whatsappLoader: wa3.loader });
  try {
    await waitFor(() => b3.whatsapp.conn.state === 'connected', { message: 'connected' });
    assert.deepEqual(b3.cfg.whatsapp.to, [A, B]);
    await waitFor(() => [jidA, jidB].every((j) => wa3.sent.some((s) => s.jid === j && /connected to WhatsApp/.test(s.content.text || ''))), { message: 'welcome to both' });

    const sid = await registerSession(b3.client, 'WA Team');
    const hook = runHook(b3.home, sid, permissionEvent('npm run team'));
    const q = await pendingQuestion(b3.client, (x) => x.session_id === sid);
    const copies = await waitFor(() => {
      const c = wa3.sent.filter((s) => s.content.text?.includes(` · ${q.id}`) && !s.content.edit);
      return c.length === 2 ? c : null;
    }, { message: 'question sent to both numbers' });
    assert.deepEqual(copies.map((c) => c.jid).sort(), [jidA, jidB]);

    // B answers by replying to their own copy; the reply to B stays in B's chat.
    const msgB = copies.find((c) => c.jid === jidB);
    const replyB = wa3.userSays('deny use staging', { quote: msgB.key, chat: jidB, fromMe: false });
    const out = await hook;
    assert.equal(out.json.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(out.json.hookSpecificOutput.decision.message, new RegExp(`use staging by whatsapp:\\+${B}`));
    await waitFor(() => wa3.reactions().some((r) => r.id === replyB && r.emoji === '✅'), { message: '✅ on B\'s reply' });
    for (const c of copies) await waitFor(() => wa3.edits().some((e) => e.id === c.key.id && /✅/.test(e.text)), { message: `copy in ${c.jid} edited` });

    // A's late reply is refused, and the explanation goes to A only.
    const msgA = copies.find((c) => c.jid === jidA);
    wa3.userSays('allow', { quote: msgA.key, chat: jidA, fromMe: false });
    const late = await waitFor(() => wa3.sent.find((s) => /already handled/.test(s.content.text || '')), { message: 'late reply explained' });
    assert.equal(late.jid, jidA);

    // `bridge whatsapp test` reaches every number.
    const r = await b3.client.post('/channels/whatsapp/test', {});
    assert.deepEqual(r.results.map((x) => [x.jid, x.ok]), [[jidA, true], [jidB, true]]);
    for (const j of [jidA, jidB]) assert.ok(wa3.sent.some((s) => s.jid === j && /Claude Bridge test message/.test(s.content.text || '')), `test message to ${j}`);
  } finally {
    await b3.shutdown('done');
  }
});
