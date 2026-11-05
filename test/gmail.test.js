// Gmail delivery mode (PUSH_MODE=gmail): question emails, reply-by-email, one-tap answer page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGas, startBridge, registerSession, runHook, waitFor, pendingQuestion, chatRecord, permissionEvent, askEvent, OWNER } from './helpers/harness.js';

const ANSWER_URL = 'https://script.google.com/a/macros/example.com/s/ANSWER/exec';
let gas;
let bridge;

before(async () => {
  gas = await startGas({ props: { SERVICE_ACCOUNT_JSON: '', PUSH_MODE: '', ANSWER_URL, CHAT_SPACE: '' } });
  bridge = await startBridge({ gas });
});

after(async () => {
  await bridge?.shutdown('done');
  await gas?.stop();
});

const threadFor = async (qid) =>
  waitFor(async () => (await gas.state()).gmail.find((t) => t.messages[0].subject.endsWith(`(${qid})`)), { message: `email for ${qid}` });
// Finds an answer link by its button text, or by action/option ("opt:1").
const linkParams = (html, label) => {
  const re = /<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  for (let m; (m = re.exec(html)); ) {
    const p = Object.fromEntries(new URL(m[1].replace(/&amp;/g, '&')).searchParams);
    if (m[2].includes(label) || `${p.a}:${p.i ?? ''}` === label) return p;
  }
  throw new Error(`no link "${label}"`);
};

test('gmail is the default push mode without a service account; ping reports it', async () => {
  await waitFor(async () => (await bridge.client.get('/health')).chat.connected === true, { message: 'connected' });
  const sid = await registerSession(bridge.client, 'Mail Ping');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run mailping'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  assert.equal(t.to, OWNER);
  assert.equal(t.messages[0].subject, `[Claude · Mail Ping] Permission: Bash npm run mailping (${q.id})`);
  assert.match(t.messages[0].html, /&#x1F4C2; Mail Ping/);
  assert.match(t.messages[0].html, /folder: Mail Ping/);
  assert.match(t.messages[0].html, /Allow for session/);
  assert.match(t.messages[0].plain, /Reply with: allow · session · deny/);
  await gas.gmailInject({ threadId: t.id, body: 'deny\n\nOn Wed, Nov 4, 2026 at 2:30 PM Owner wrote:\n> allow', from: `Owner <${OWNER}>`, sent: true });
  await gas.run('gmailPoll');
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'deny');
});

test('reply by email "allow" approves; a bot confirmation lands in the same thread', async () => {
  const sid = await registerSession(bridge.client, 'Mail Allow');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run mailallow'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  await gas.gmailInject({ threadId: t.id, body: 'allow', from: `Jay <${OWNER}>`, sent: true });
  await gas.run('gmailPoll');
  assert.deepEqual((await hook).json.hookSpecificOutput.decision, { behavior: 'allow' });
  const after = (await gas.state()).gmail.find((x) => x.id === t.id);
  assert.ok(after.messages.some((m) => m.plain.includes('Got it: Allow')));
  await waitFor(async () => (await gas.state()).gmail.find((x) => x.id === t.id).labels.includes('Claude Assistant/Answered'), { message: 'thread labelled' });
});

test('replies not sent from the owner account are ignored (forged From)', async () => {
  const sid = await registerSession(bridge.client, 'Mail Forged');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run forged'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  await gas.gmailInject({ threadId: t.id, body: 'allow', from: `Owner <${OWNER}>`, sent: false }); // not in Sent
  await gas.gmailInject({ threadId: t.id, body: 'allow', from: 'mallory@evil.com', sent: true });
  await gas.run('gmailPoll');
  assert.equal(JSON.parse((await gas.state()).props[`Q_${q.id}`]).status, 'PENDING');
  await gas.gmailInject({ threadId: t.id, body: 'deny', from: OWNER, sent: true });
  await gas.run('gmailPoll');
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'deny');
});

test('free-text reply and option numbers from an email reply', async () => {
  const sid = await registerSession(bridge.client, 'Mail Ask');
  const hook = runHook(bridge.home, sid, askEvent([{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'MySQL' }] }]));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  await gas.gmailInject({ threadId: t.id, body: 'SQLite, it is only a prototype\n\n> Which DB?', from: OWNER, sent: true });
  await gas.run('gmailPoll');
  assert.equal((await hook).json.hookSpecificOutput.updatedInput.answers['Which DB?'], 'SQLite, it is only a prototype');
});

test('one-tap answer page: identity + token checked, confirm records the answer', async () => {
  const sid = await registerSession(bridge.client, 'Mail Link');
  const hook = runHook(bridge.home, sid, askEvent([{ question: 'Deploy target?', header: 'T', multiSelect: false, options: [{ label: 'staging' }, { label: 'production' }] }]));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  const p = linkParams(t.messages[0].html, 'opt:1');
  // Opening the link only shows a confirmation page (link scanners can't answer).
  const page = (await gas.call('doGet', [{ parameter: p }], OWNER)).result.html;
  assert.match(page, /Your answer: <b>2\. production<\/b>/);
  assert.match(t.messages[0].html, /production/);
  assert.equal(JSON.parse((await gas.state()).props[`Q_${q.id}`]).status, 'PENDING');
  // Not signed in / other user → refused.
  assert.match((await gas.call('doGet', [{ parameter: p }], '')).result.html, /Not allowed/);
  assert.match((await gas.call('answerFromPage', [p], 'intruder@evil.com')).thrown, /not allowed/);
  // Tampered token or action → refused.
  assert.match((await gas.call('answerFromPage', [{ ...p, i: '0' }], OWNER)).thrown, /invalid link/);
  const r = await gas.call('answerFromPage', [p], OWNER);
  assert.match(r.result, /Sent to session_\d+: production/);
  assert.equal((await hook).json.hookSpecificOutput.updatedInput.answers['Deploy target?'], 'production');
  assert.match((await gas.call('answerFromPage', [p], OWNER)).result, /Already handled/);
});

test('sensitive permission via link requires the confirmation box', async () => {
  const sid = await registerSession(bridge.client, 'Mail Danger');
  const hook = runHook(bridge.home, sid, permissionEvent('rm -rf build'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  assert.doesNotMatch(t.messages[0].html, /Allow for session/);
  const p = linkParams(t.messages[0].html, 'Allow');
  assert.match((await gas.call('doGet', [{ parameter: p }], OWNER)).result.html, /I understand and want to allow this/);
  assert.match((await gas.call('answerFromPage', [{ ...p, confirm: false }], OWNER)).result, /Tick the confirmation box/);
  await gas.call('answerFromPage', [{ ...p, confirm: true }], OWNER);
  assert.equal((await hook).json.hookSpecificOutput.decision.behavior, 'allow');
});

test('multi-question form via the answer page', async () => {
  const sid = await registerSession(bridge.client, 'Mail Form');
  const questions = [
    { question: 'Features?', header: 'F', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }] },
    { question: 'Ship now?', header: 'S', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
  ];
  const hook = runHook(bridge.home, sid, askEvent(questions));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  const p = linkParams(t.messages[0].html, 'Answer');
  await gas.call('answerFromPage', [{ ...p, answers: [{ picked: ['Auth', 'Billing'], other: '' }, { picked: [], other: 'next week' }] }], OWNER);
  assert.deepEqual((await hook).json.hookSpecificOutput.updatedInput.answers, { 'Features?': 'Auth, Billing', 'Ship now?': 'next week' });
});

test('answer rejected by the bridge is reported in the thread', async () => {
  const sid = await registerSession(bridge.client, 'Mail Stale');
  await runHook(bridge.home, sid, { hook_event_name: 'Stop', last_assistant_message: 'Should I continue?' });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  // The session stops waiting at the prompt before the email reply arrives (state changed locally).
  bridge.db.updateSession(sid, { waiting_prompt: 0 });
  await gas.gmailInject({ threadId: t.id, body: 'yes go on', from: OWNER, sent: true });
  await gas.run('gmailPoll');
  await waitFor(async () => (await gas.state()).gmail.find((x) => x.id === t.id).messages.some((m) => /Not delivered: the session is no longer waiting/.test(m.plain)), { message: 'rejection mailed' });
});

test('email commands: "claude sessions" gets a reply in the same thread', async () => {
  await registerSession(bridge.client, 'Mail Cmd');
  await waitFor(async () => /Mail Cmd/.test((await gas.state()).props.SESSIONS || ''), { message: 'snapshot' });
  const threadId = (await gas.gmailInject({ subject: 'claude sessions', body: '' })).id;
  await gas.run('gmailPoll');
  const t = (await gas.state()).gmail.find((x) => x.id === threadId);
  assert.match(t.messages.at(-1).plain, /Mail Cmd/);
  await gas.run('gmailPoll'); // processed once only
  assert.equal((await gas.state()).gmail.find((x) => x.id === threadId).messages.length, 2);
});

test('notifications are emailed in gmail mode', async () => {
  const sid = await registerSession(bridge.client, 'Mail Exit');
  await bridge.client.post(`/runner/${sid}/exit`, { exitCode: 3 });
  await waitFor(async () => (await gas.state()).gmail.some((t) => /\[Claude · Mail Exit\] .*Session failed/.test(t.messages[0].subject) && /Mail Exit/.test(t.messages[0].plain)), { message: 'failure email' });
});

test('a reply to a question that was already handled gets an explanation (never silence)', async () => {
  const sid = await registerSession(bridge.client, 'Mail Late');
  const hook = runHook(bridge.home, sid, permissionEvent('npm run late'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  hook.child.kill('SIGTERM'); // answered in the terminal
  await waitFor(async () => JSON.parse((await gas.state()).props[`Q_${q.id}`]).status === 'ANSWERED_LOCALLY', { message: 'synced', timeoutMs: 10000 });
  await gas.gmailInject({ threadId: t.id, body: 'allow', from: OWNER, sent: true });
  await gas.run('gmailPoll');
  const msgs = (await gas.state()).gmail.find((x) => x.id === t.id).messages;
  assert.match(msgs.at(-1).plain, /already handled — Answered in the terminal[\s\S]*NOT sent to Claude/);
  assert.match(msgs.at(-1).html, /&#x1F4BB; Answered in the terminal/, 'emoji kept (as an entity) in the HTML part');
});

test('email signature (logo link, name, phone, social links) is not sent to Claude', async () => {
  const sid = await registerSession(bridge.client, 'Mail Signature');
  await runHook(bridge.home, sid, { hook_event_name: 'Stop', last_assistant_message: 'Done. What next?' });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid && x.kind === 'free_text');
  const t = await threadFor(q.id);
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
  const signature = '<https://example.com/>\n\nAlex Example\n\nSoftware Engineer\nalex@example.com\n+91 98765 43210 <+919876543210>\nPune, India\n<https://www.linkedin.com/company/example>\n<https://x.com/example>';
  await gas.gmailInject({ threadId: t.id, body: `Please add unit tests for the router.\n\n${signature}\n\nOn Wed, Nov 4, 2026 at 5:30 PM Claude Assistant <${OWNER}> wrote:\n> Done. What next?`, from: `Alex Example <${OWNER}>`, sent: true });
  await gas.run('gmailPoll');
  assert.equal(await typed, 'Please add unit tests for the router.');
});

test('option number followed by a signature still picks the option', async () => {
  const sid = await registerSession(bridge.client, 'Mail Sig Option');
  const hook = runHook(bridge.home, sid, askEvent([{ question: 'Env?', header: 'E', multiSelect: false, options: [{ label: 'dev' }, { label: 'prod' }] }]));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  await gas.gmailInject({ threadId: t.id, body: '1\n\nAlex Example\nSoftware Engineer\n<https://example.com/>', from: `Alex Example <${OWNER}>`, sent: true });
  await gas.run('gmailPoll');
  assert.equal((await hook).json.hookSpecificOutput.updatedInput.answers['Env?'], 'dev');
});

test('plain-text parts never contain emoji (Apps Script garbles them); HTML parts keep them', async () => {
  const st = await gas.state();
  for (const t of st.gmail) {
    for (const m of t.messages.filter((x) => x.from.includes(OWNER) && x.plain && x.plain.startsWith('[Claude Assistant]'))) {
      assert.doesNotMatch(m.plain, /[\u{1F000}-\u{1FFFF}]/u, `emoji in plain text: ${m.plain.slice(0, 80)}`);
      assert.ok(m.html, 'has an HTML part');
    }
  }
});

test('emails never contain raw astral emoji (GmailApp garbles them): HTML uses entities, subjects drop them', async () => {
  const st = await gas.state();
  const sentByScript = st.gmail.flatMap((t) => t.messages).filter((m) => m.html);
  assert.ok(sentByScript.length > 5);
  for (const m of sentByScript) {
    assert.doesNotMatch(m.html, /[\u{10000}-\u{10FFFF}]/u, 'raw emoji in HTML');
    assert.doesNotMatch(m.subject || '', /[\u{10000}-\u{10FFFF}]/u, 'raw emoji in subject');
  }
  assert.ok(sentByScript.some((m) => /&#x1F4C2;/.test(m.html)), '📂 written as an entity');
});

// ---- context + quota ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeTranscript(entries) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-tr-')), 't.jsonl');
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return f;
}
const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });

test('polling makes no Gmail calls (only the 1-minute trigger reads mail)', async () => {
  const before = (await gas.state()).gmailSearches;
  await new Promise((r) => setTimeout(r, 4000)); // several long-polls happen meanwhile
  assert.equal((await gas.state()).gmailSearches, before);
});

test('finished task email: subject says Finished, body has your request, what Claude did and its summary', async () => {
  const sid = await registerSession(bridge.client, 'Mail Done');
  const tr = writeTranscript([
    user('Add input validation to the signup form and run the tests'),
    assistant([{ type: 'text', text: 'Let me look at the form.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/Mail Done/src/signup.js' } }]),
    user([{ type: 'tool_result', content: 'ok' }]),
    assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/Mail Done/src/signup.js' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
    user([{ type: 'tool_result', content: 'ok' }]),
    assistant([{ type: 'text', text: 'Added **email and password validation**. All 42 tests pass.' }]),
  ]);
  await runHook(bridge.home, sid, { hook_event_name: 'Stop', cwd: '/tmp/Mail Done', transcript_path: tr, last_assistant_message: 'Added **email and password validation**. All 42 tests pass.' });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  assert.equal(q.title, '✅ Task finished');
  const t = await threadFor(q.id);
  assert.equal(t.messages[0].subject, `[Claude · Mail Done] ✅ Finished: Add input validation to the signup form and run the tests (${q.id})`);
  const html = t.messages[0].html;
  assert.match(html, /You asked/);
  assert.match(html, /Add input validation to the signup form/);
  assert.match(html, /What Claude did/);
  assert.match(html, /<b>Edited<\/b> src\/signup\.js/);
  assert.match(html, /<b>Ran<\/b>: npm test/);
  assert.match(html, /<b>Read<\/b> 1 file/);
  assert.match(html, /<b>email and password validation<\/b>/);
  assert.match(t.messages[0].plain, /You asked: Add input validation/);
});

test('question email shows what Claude said right before asking', async () => {
  const sid = await registerSession(bridge.client, 'Mail Ctx');
  const tr = writeTranscript([
    user('Migrate the database'),
    assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npx prisma migrate status' } }]),
    user([{ type: 'tool_result', content: '2 pending' }]),
    assistant([{ type: 'text', text: 'There are 2 pending migrations, one of them drops a column.' }]),
  ]);
  const hook = runHook(bridge.home, sid, { ...askEvent([{ question: 'Apply both migrations?', header: 'M', multiSelect: false, options: [{ label: 'Yes' }, { label: 'Only the safe one' }] }]), transcript_path: tr, cwd: '/tmp' });
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  const t = await threadFor(q.id);
  assert.match(t.messages[0].html, /Claude said before asking/);
  assert.match(t.messages[0].html, /one of them drops a column/);
  assert.match(t.messages[0].html, /<b>Ran<\/b>: npx prisma migrate status/);
  await gas.gmailInject({ threadId: t.id, body: '2', from: OWNER, sent: true });
  await gas.run('gmailPoll');
  assert.equal((await hook).json.hookSpecificOutput.updatedInput.answers['Apply both migrations?'], 'Only the safe one');
});
