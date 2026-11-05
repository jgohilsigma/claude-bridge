// BRIDGE_WHATSAPP_GROUPS=on: one WhatsApp group per session, named "Claude - <project>".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, registerSession, runHook, waitFor, pendingQuestion, permissionEvent, askEvent, tempHome } from './helpers/harness.js';
import { createFakeWhatsApp, linkedHome, MY_NUMBER, MY_JID } from './helpers/fake-whatsapp.js';

const A = '919812345678';
const B = '919822222222';
const OUTSIDER = '15550001111';
let wa;
let bridge;

before(async () => {
  wa = createFakeWhatsApp();
  wa.lids.set(A, '555000111@lid'); // A shows up by LID in groups, like current WhatsApp
  wa.blocked.add(B); // B's privacy settings refuse being added
  bridge = await startBridge({
    home: linkedHome(tempHome()),
    env: { BRIDGE_CHANNELS: 'whatsapp', BRIDGE_APPS_SCRIPT_URL: '', BRIDGE_WHATSAPP_TO: `${MY_NUMBER},${A},${B}`, BRIDGE_WHATSAPP_GROUPS: 'on' },
    whatsappLoader: wa.loader,
  });
  await waitFor(() => bridge.whatsapp.conn.state === 'connected', { message: 'connected' });
});

after(async () => {
  await bridge?.shutdown('done');
});

const groupOf = (sid) => waitFor(() => bridge.db.whatsAppGroup({ sessionId: sid }), { message: `group for ${sid}` });
const sentIn = (jid, re) => waitFor(() => wa.sent.find((s) => s.jid === jid && !s.content.edit && re.test(s.content.text || '')), { message: `message ${re} in ${jid}` });

test('a new session gets its own group "Claude - <name>" with the other numbers; no 1-to-1 welcome', async () => {
  const sid = await registerSession(bridge.client, 'Session 1');
  const g = await groupOf(sid);
  const created = wa.groups.find((x) => x.jid === g.jid);
  assert.equal(created.subject, 'Claude - Session 1');
  assert.deepEqual(created.participants, [`${A}@s.whatsapp.net`], 'own number is the creator; B refused');
  await sentIn(g.jid, /Claude - Session 1/);
  // B couldn't be added: gets an invite link instead.
  await sentIn(`${B}@s.whatsapp.net`, /chat\.whatsapp\.com\/INVITE123/);
  assert.equal(wa.texts().some((t) => /connected to WhatsApp/.test(t)), false, 'no 1-to-1 welcome in group mode');
});

test('questions go only to the session group; a member answers from the group (by LID); copies update', async () => {
  const sid = await registerSession(bridge.client, 'Session 2');
  const g = await groupOf(sid);
  const hook = runHook(bridge.home, sid, permissionEvent('npm run groups'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const msg = await sentIn(g.jid, new RegExp(` · ${q.id}`));
  assert.equal(wa.sent.filter((s) => s.content.text?.includes(` · ${q.id}`) && !s.content.edit).length, 1, 'only in the group');

  wa.userSays('allow', { quote: msg.key, chat: g.jid, fromMe: false, participant: `${OUTSIDER}@s.whatsapp.net` }); // not a member
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await bridge.client.get('/questions?status=PENDING')).questions.some((x) => x.id === q.id), 'outsider ignored');

  wa.userSays('deny not now', { quote: msg.key, chat: g.jid, fromMe: false, participant: '555000111@lid' });
  const out = await hook;
  assert.match(out.json.hookSpecificOutput.decision.message, new RegExp(`not now by whatsapp:\\+${A}`));
  await waitFor(() => wa.edits().some((e) => e.id === msg.key.id && /✅/.test(e.text)), { message: 'group copy edited' });
});

test('a plain reply in a group answers that session\'s question even when other sessions have open ones', async () => {
  const s3 = await registerSession(bridge.client, 'Session 3');
  const s4 = await registerSession(bridge.client, 'Session 4');
  const [g3, g4] = [await groupOf(s3), await groupOf(s4)];
  const ask = (q) => askEvent([{ question: q, header: 'H', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }]);
  const h3 = runHook(bridge.home, s3, ask('Three?'));
  const h4 = runHook(bridge.home, s4, ask('Four?'));
  const q3 = await pendingQuestion(bridge.client, (x) => x.session_id === s3);
  const q4 = await pendingQuestion(bridge.client, (x) => x.session_id === s4);
  await sentIn(g3.jid, new RegExp(q3.id));
  await sentIn(g4.jid, new RegExp(q4.id));
  wa.userSays('2', { chat: g4.jid }); // you, from your phone, in Session 4's group
  assert.equal((await h4).json.hookSpecificOutput.updatedInput.answers['Four?'], 'No');
  wa.userSays('1', { chat: g3.jid });
  assert.equal((await h3).json.hookSpecificOutput.updatedInput.answers['Three?'], 'Yes');
});

test('session end notice goes to its group and the group is kept; messages from unknown groups are ignored', async () => {
  const sid = await registerSession(bridge.client, 'Session 5');
  const g = await groupOf(sid);
  await bridge.client.post(`/runner/${sid}/exit`, { exitCode: 1 });
  await sentIn(g.jid, /Session failed/);
  assert.ok(bridge.db.whatsAppGroup({ sessionId: sid }), 'group kept');

  const s6 = await registerSession(bridge.client, 'Session 6');
  const hook = runHook(bridge.home, s6, permissionEvent('npm run other'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === s6);
  await sentIn((await groupOf(s6)).jid, new RegExp(q.id));
  wa.userSays(`${q.id} allow`, { chat: '99999@g.us', fromMe: false, participant: `${A}@s.whatsapp.net` });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await bridge.client.get('/questions?status=PENDING')).questions.some((x) => x.id === q.id), 'still pending');
  wa.userSays(`${q.id} allow`, { chat: (await groupOf(s6)).jid });
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
});

test('whatsapp test goes to the running sessions\' groups', async () => {
  const r = await bridge.client.post('/channels/whatsapp/test', {});
  assert.equal(r.groups, true);
  assert.ok(r.results.length >= 1 && r.results.every((x) => x.ok && x.jid.endsWith('@g.us') && /^Claude - /.test(x.name)));
  assert.equal(r.results.some((x) => x.jid === MY_JID), false);
});
