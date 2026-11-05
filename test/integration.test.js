// End-to-end tests: real Code.gs (in a simulated Apps Script runtime with the 302 redirect
// behaviour), real daemon, real hook processes, simulated Google Chat clicks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startGas, startBridge, registerSession, runHook, waitFor, pendingQuestion, chatRecord,
  addonClick, addonMessage, addonCommand, legacyClick, formText, permissionEvent, askEvent, OWNER, tempHome,
} from './helpers/harness.js';

let gas;
let bridge;

before(async () => {
  gas = await startGas();
  bridge = await startBridge({ gas });
});

after(async () => {
  await bridge?.shutdown('tests done');
  await gas?.stop();
});

const click = (q, act, extra = {}, opts = {}) => gas.chat('onCardAction', addonClick({ params: { act, q: q.id, s: q.session_id, ...extra }, ...opts }));
const cardText = (resp) => JSON.stringify(resp);

test('permission request: pushed as an interactive card, Allow click reaches the hook', async () => {
  const sid = await registerSession(bridge.client, 'SPM Backend');
  const hook = runHook(bridge.home, sid, permissionEvent('npm test'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  assert.equal(q.kind, 'permission');
  const rec = await chatRecord(gas, q.id);
  const state = await gas.state();
  const pushed = state.pushes.find((p) => p.kind === 'create' && p.name.endsWith(`client-${q.id}`));
  assert.ok(pushed, 'card pushed with client-assigned message id');
  assert.match(JSON.stringify(pushed.msg.cardsV2), /npm test/);
  assert.match(JSON.stringify(pushed.msg.cardsV2), /SPM Backend/);
  assert.equal(rec.status, 'PENDING');

  const resp = await click(q, 'allow');
  assert.ok(resp.hostAppDataAction.chatDataAction.updateMessageAction, 'add-on update response');
  assert.match(cardText(resp), /Answer recorded/);
  const out = await hook;
  assert.deepEqual(out.json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  await waitFor(async () => JSON.parse((await gas.state()).props[`Q_${q.id}`]).status === 'DELIVERED', { message: 'DELIVERED status synced to Chat' });
});

test('duplicate clicks: the second click is rejected and the hook only gets one answer', async () => {
  const sid = await registerSession(bridge.client, 'Dup');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run lint'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  await click(q, 'deny');
  const second = await click(q, 'allow');
  assert.match(cardText(second), /Already handled|Answer recorded|Delivered/);
  const out = await hook;
  assert.equal(out.json.hookSpecificOutput.decision.behavior, 'deny');
  const st = await gas.state();
  const responses = (st.sheets.Responses || []).filter((r) => r[2] === q.id);
  assert.equal(responses.length, 1, 'exactly one response recorded');
});

test('AskUserQuestion: single question option click → updatedInput.answers', async () => {
  const sid = await registerSession(bridge.client, 'Ask');
  const questions = [{ question: 'I found 11 test-case files. What should I do?', header: 'Tests', multiSelect: false, options: [{ label: 'Verify and fix failures', description: '' }, { label: 'Verify only, report', description: '' }] }];
  const hook = runHook(bridge.home, sid, askEvent(questions));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  await click(q, 'opt', { i: 1 });
  const out = await hook;
  assert.equal(out.json.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(out.json.hookSpecificOutput.updatedInput.questions, questions);
  assert.deepEqual(out.json.hookSpecificOutput.updatedInput.answers, { 'I found 11 test-case files. What should I do?': 'Verify only, report' });
});

test('AskUserQuestion: "Type something" dialog → custom text answer', async () => {
  const sid = await registerSession(bridge.client, 'AskText');
  const questions = [{ question: 'Which port?', header: 'Port', multiSelect: false, options: [{ label: '3000' }, { label: '8080' }] }];
  const hook = runHook(bridge.home, sid, askEvent(questions));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  const dialog = await click(q, 'text');
  assert.ok(dialog.action.navigations[0].pushCard, 'opens a dialog');
  const submitted = await click(q, 'submitText', {}, { form: { answer: formText('Use 4321 instead') }, dialog: true });
  assert.ok(submitted.hostAppDataAction.chatDataAction.updateMessageAction, 'dialog closes by updating the card');
  const out = await hook;
  assert.equal(out.json.hookSpecificOutput.updatedInput.answers['Which port?'], 'Use 4321 instead');
});

test('AskUserQuestion: multiple questions + multi-select via the form dialog', async () => {
  const sid = await registerSession(bridge.client, 'AskMulti');
  const questions = [
    { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }] },
    { question: 'Deploy now?', header: 'Deploy', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
  ];
  const hook = runHook(bridge.home, sid, askEvent(questions));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  const dialog = await click(q, 'form');
  assert.match(JSON.stringify(dialog), /CHECK_BOX/);
  await click(q, 'submitForm', {}, { form: { q0: { stringInputs: { value: ['Auth', 'Search'] } }, q1: { stringInputs: { value: ['No'] } } }, dialog: true });
  const out = await hook;
  assert.deepEqual(out.json.hookSpecificOutput.updatedInput.answers, { 'Which features?': 'Auth, Search', 'Deploy now?': 'No' });
});

test('dangerous permission: Allow requires a second confirmation; allow-for-session not offered', async () => {
  const sid = await registerSession(bridge.client, 'Danger');
  const hook = runHook(bridge.home, sid, permissionEvent('git push --force origin main'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const rec = await chatRecord(gas, q.id);
  assert.equal(rec.q.permission.dangerous, true);
  const card = cardText((await gas.state()).pushes.find((p) => p.name?.endsWith(`client-${q.id}`)).msg);
  assert.doesNotMatch(card, /Allow for session/);
  assert.match(card, /Sensitive operation/);
  const confirmCard = await click(q, 'allowConfirm');
  assert.match(cardText(confirmCard), /Yes, allow/);
  // A forged "allow" without confirmation is refused by Apps Script…
  const forged = await click(q, 'allow');
  assert.match(cardText(forged), /Confirm/);
  assert.equal(JSON.parse((await gas.state()).props[`Q_${q.id}`]).status, 'PENDING');
  // …and only the confirmed click goes through.
  await click(q, 'allow', { c: '1' });
  const out = await hook;
  assert.equal(out.json.hookSpecificOutput.decision.behavior, 'allow');
});

test('allow for session returns a session-scoped rule only', async () => {
  const sid = await registerSession(bridge.client, 'SessionRule');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run build'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  await click(q, 'allowSession');
  const out = await hook;
  assert.deepEqual(out.json.hookSpecificOutput.decision.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }], behavior: 'allow', destination: 'session' }]);
});

test('unauthorized Chat users are refused and nothing is recorded', async () => {
  const sid = await registerSession(bridge.client, 'Auth');
  const hook = runHook(bridge.home, sid, permissionEvent('npm ci'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  const r = await click(q, 'allow', {}, { email: 'intruder@evil.com' });
  assert.match(cardText(r), /not on the allowlist/);
  assert.equal(JSON.parse((await gas.state()).props[`Q_${q.id}`]).status, 'PENDING');
  await click(q, 'deny');
  await hook;
});

test('session id tampering in a button is rejected', async () => {
  const a = await registerSession(bridge.client, 'Tamper A');
  const hook = runHook(bridge.home, a, permissionEvent('echo a'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === a);
  await chatRecord(gas, q.id);
  const r = await gas.chat('onCardAction', addonClick({ params: { act: 'allow', q: q.id, s: 'session_999' } }));
  assert.match(cardText(r), /Session mismatch/);
  await click(q, 'deny');
  await hook;
});

test('bridge re-validates: an injected answer for the wrong session or an unlisted user is rejected', async () => {
  const a = await registerSession(bridge.client, 'Route A');
  const b = await registerSession(bridge.client, 'Route B');
  const hookA = runHook(bridge.home, a, permissionEvent('echo route-a'));
  const qa = await pendingQuestion(bridge.client, (x) => x.session_id === a);
  await chatRecord(gas, qa.id);
  // Responses written directly into Apps Script storage (bypassing its checks).
  const bad1 = { id: 'forged-1', questionId: qa.id, sessionId: b, type: 'allow', value: {}, user: OWNER, createdAt: Date.now() };
  const bad2 = { id: 'forged-2', questionId: qa.id, sessionId: a, type: 'allow', value: {}, user: 'mallory@evil.com', createdAt: Date.now() };
  await gas.setProps({ R_forged1: JSON.stringify(bad1), R_forged2: JSON.stringify(bad2) });
  await waitFor(async () => {
    const { entries } = await bridge.client.get('/audit?limit=100');
    return entries.filter((e) => e.action === 'response.rejected' && e.question_id === qa.id).length >= 2;
  }, { message: 'forged responses rejected' });
  const { questions } = await bridge.client.get('/questions?status=PENDING');
  assert.ok(questions.find((x) => x.id === qa.id), 'question still pending');
  await click(qa, 'deny');
  assert.equal((await hookA).json.hookSpecificOutput.decision.behavior, 'deny');
});

test('concurrent sessions: answers are routed to the right hook', async () => {
  const ids = await Promise.all(['Multi 1', 'Multi 2', 'Multi 3'].map((n) => registerSession(bridge.client, n)));
  const hooks = ids.map((sid, i) => runHook(bridge.home, sid, permissionEvent(`echo multi-${i}`)));
  const qs = await Promise.all(ids.map((sid) => pendingQuestion(bridge.client, (x) => x.session_id === sid)));
  await Promise.all(qs.map((q) => chatRecord(gas, q.id)));
  // Answer in reverse order with different decisions.
  await click(qs[2], 'allow');
  await click(qs[0], 'deny');
  await click(qs[1], 'allowSession');
  const outs = await Promise.all(hooks);
  assert.equal(outs[0].json.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(outs[1].json.hookSpecificOutput.decision.updatedPermissions[0].rules[0].ruleContent, 'echo multi-1');
  assert.deepEqual(outs[2].json.hookSpecificOutput.decision, { behavior: 'allow' });
  const { sessions } = await bridge.client.get('/sessions');
  assert.ok(sessions.filter((s) => ids.includes(s.id)).every((s) => s.display_status === 'RUNNING'));
});

test('legacy (non add-on) Chat events are handled too', async () => {
  const sid = await registerSession(bridge.client, 'Legacy');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run legacy'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  const r = await gas.chat('onCardClick', legacyClick({ params: { act: 'allow', q: q.id, s: sid } }));
  assert.equal(r.actionResponse.type, 'UPDATE_MESSAGE');
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
});

test('Chat commands: /sessions, /status, /pending, /reply, /cancel, /help', async () => {
  const sid = await registerSession(bridge.client, 'Commands');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run cmd'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  await waitFor(async () => /Commands/.test(JSON.parse((await gas.state()).props.SESSIONS || '{}').sessions?.map((s) => s.project).join() || ''), { message: 'session snapshot' });
  const msg = (r) => r.hostAppDataAction.chatDataAction.createMessageAction.message;
  assert.match(msg(await gas.chat('onAppCommand', addonCommand({ commandId: 1 }))).text, /Commands.*WAITING/);
  assert.match(msg(await gas.chat('onMessage', addonMessage({ text: '/status' }))).text, /Bridge: 🟢 online/);
  const pending = msg(await gas.chat('onAppCommand', addonCommand({ commandId: 3 })));
  assert.ok(pending.cardsV2.some((c) => c.cardId === `q_${q.id}`));
  assert.match(msg(await gas.chat('onMessage', addonMessage({ text: `/reply ${q.id} maybe` }))).text, /allow`, `session` or `deny/);
  assert.match(msg(await gas.chat('onMessage', addonMessage({ text: `/reply ${q.id} deny not today` }))).text, /Sent to/);
  assert.equal((await hook).json.hookSpecificOutput.decision.message, `not today by ${OWNER}`);
  assert.match(msg(await gas.chat('onMessage', addonMessage({ text: 'help' }))).text, /\/sessions/);
  assert.match(msg(await gas.chat('onMessage', addonMessage({ text: `/cancel ${q.id}` }))).text, /Already handled/);
});

test('free-text: Stop hook → reply typed into the session (via the runner command channel)', async () => {
  const sid = await registerSession(bridge.client, 'FreeText');
  const stop = await runHook(bridge.home, sid, { session_id: 'c1', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Tests done.\n\nWhat next?\n1. Fix failures\n2. Write a report' });
  assert.equal(stop.json, null);
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid && x.kind === 'free_text');
  assert.deepEqual(q.options.map((o) => o.label), ['Fix failures', 'Write a report']);
  await chatRecord(gas, q.id);
  // Act as the runner: long-poll commands and acknowledge the injection.
  const typed = (async () => {
    for (;;) {
      const { commands } = await bridge.client.get(`/runner/${sid}/commands?wait=5`, { timeoutMs: 10000 });
      const c = commands.find((x) => x.type === 'text');
      if (c) {
        await bridge.client.post(`/runner/${sid}/command-result`, { id: c.id, ok: true });
        return c;
      }
    }
  })();
  await click(q, 'opt', { i: 0 });
  const c = await typed;
  assert.equal(c.text, 'Fix failures');
  assert.equal(c.requireNoMenu, true);
  await waitFor(async () => (await bridge.client.get('/questions?status=DELIVERED')).questions.some((x) => x.id === q.id), { message: 'delivered' });
});

test('free-text answered at the keyboard first: Chat answer is rejected as stale', async () => {
  const sid = await registerSession(bridge.client, 'Stale');
  await runHook(bridge.home, sid, { session_id: 'c2', hook_event_name: 'Stop', last_assistant_message: 'Should I continue?' });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid && x.kind === 'free_text');
  await chatRecord(gas, q.id);
  await runHook(bridge.home, sid, { session_id: 'c2', hook_event_name: 'UserPromptSubmit', prompt: 'typed locally' });
  await waitFor(async () => JSON.parse((await gas.state()).props[`Q_${q.id}`]).status === 'ANSWERED_LOCALLY', { message: 'card shows answered locally' });
  const r = await click(q, 'opt', { i: 0 });
  assert.match(cardText(r), /Already handled/);
});

test('local takeover releases the AskUserQuestion hook so Claude shows its own dialog (question stays open)', async () => {
  const sid = await registerSession(bridge.client, 'Takeover');
  const hook = runHook(bridge.home, sid, askEvent([{ question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const r = await bridge.client.post(`/runner/${sid}/takeover`, {});
  assert.deepEqual(r.released, [q.id]);
  const out = await hook;
  assert.equal(out.stdout, '', 'no output → Claude shows its own prompt');
  assert.ok((await bridge.client.get('/questions?status=PENDING')).questions.some((x) => x.id === q.id), 'still answerable remotely');
});

test('hook killed by Claude (answered in terminal) marks the question answered locally', async () => {
  const sid = await registerSession(bridge.client, 'Killed');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run killed'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  hook.child.kill('SIGTERM');
  await waitFor(async () => (await bridge.client.get('/questions?status=ANSWERED_LOCALLY')).questions.some((x) => x.id === q.id), { message: 'answered locally', timeoutMs: 8000 });
});

test('hook fails open (no output) when the session is unknown or no daemon is running', async () => {
  const unknown = await runHook(bridge.home, 'session_999', permissionEvent('ls'));
  assert.equal(unknown.stdout, '');
  const nobody = await runHook(tempHome(), 'session_001', permissionEvent('ls'));
  assert.equal(nobody.stdout, '');
  const notBridge = await runHook(bridge.home, '', permissionEvent('ls'));
  assert.equal(notBridge.stdout, '');
});

test('AskUserQuestion via PermissionRequest becomes a real question (not a raw-JSON permission)', async () => {
  const sid = await registerSession(bridge.client, 'AskViaPerm');
  const questions = [{ question: 'What to work on?', header: 'Task', multiSelect: false, options: [{ label: 'Explore', description: 'Overview' }, { label: 'Fix a bug', description: 'Debug' }] }];
  const hook = runHook(bridge.home, sid, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  assert.equal(q.kind, 'ask_user_question');
  await chatRecord(gas, q.id);
  await click(q, 'opt', { i: 1 });
  assert.deepEqual((await hook).json.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { questions, answers: { 'What to work on?': 'Fix a bug' } } });
});

test('after a local takeover, the emailed/Chat answer still reaches Claude through the permission dialog', async () => {
  const sid = await registerSession(bridge.client, 'AskHandoff');
  const questions = [{ question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  const pre = runHook(bridge.home, sid, askEvent(questions));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await chatRecord(gas, q.id);
  await bridge.client.post(`/runner/${sid}/takeover`, {});
  assert.equal((await pre).stdout, '');
  // Claude now draws its dialog and asks through PermissionRequest: same question, no new one.
  const perm = runHook(bridge.home, sid, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });
  await waitFor(async () => bridge.questions.hasWaiter(q.id), { message: 're-attached' });
  const open = (await bridge.client.get('/questions?status=PENDING')).questions.filter((x) => x.session_id === sid);
  assert.deepEqual(open.map((x) => x.id), [q.id]);
  await click(q, 'opt', { i: 1 });
  assert.deepEqual((await perm).json.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { questions, answers: { 'Pick?': 'B' } } });
});

test('after a local takeover, answering in the terminal closes the remote question', async () => {
  const sid = await registerSession(bridge.client, 'AskHandoffLocal');
  const questions = [{ question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  const pre = runHook(bridge.home, sid, askEvent(questions));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  await bridge.client.post(`/runner/${sid}/takeover`, {});
  await pre;
  const perm = runHook(bridge.home, sid, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });
  await waitFor(async () => bridge.questions.hasWaiter(q.id), { message: 're-attached' });
  perm.child.kill('SIGTERM'); // Claude kills the hook when the dialog is answered at the keyboard
  await waitFor(async () => (await bridge.client.get('/questions?status=ANSWERED_LOCALLY')).questions.some((x) => x.id === q.id), { message: 'answered locally', timeoutMs: 8000 });
});
