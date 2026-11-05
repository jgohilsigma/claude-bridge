// Talking to Claude from WhatsApp: messages that answer no question become new prompts, and
// `/new <name>` starts a session on this PC from the phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, registerSession, runHook, waitFor, pendingQuestion, permissionEvent, tempHome } from './helpers/harness.js';
import { createFakeWhatsApp, linkedHome, MY_NUMBER, MY_JID } from './helpers/fake-whatsapp.js';
import { parseStartArgs } from '../src/channels/whatsapp/channel.js';
import { resolveStartDir } from '../src/terminal/launcher.js';

const A = '919812345678';
let wa;
let bridge;

before(async () => {
  wa = createFakeWhatsApp();
  bridge = await startBridge({
    home: linkedHome(tempHome()),
    env: { BRIDGE_CHANNELS: 'whatsapp', BRIDGE_APPS_SCRIPT_URL: '', BRIDGE_WHATSAPP_TO: `${MY_NUMBER},${A}`, BRIDGE_WHATSAPP_GROUPS: 'on' },
    whatsappLoader: wa.loader,
  });
  await waitFor(() => bridge.whatsapp.conn.state === 'connected', { message: 'connected' });
});

after(async () => {
  await bridge?.shutdown('done');
});

const groupOf = (sid) => waitFor(() => bridge.db.whatsAppGroup({ sessionId: sid }), { message: `group for ${sid}` });
const replyTo = (id, re) => waitFor(() => wa.texts().find((t) => re.test(t)) && wa.sent.find((s) => s.content.text && re.test(s.content.text)), { message: `reply ${re} to ${id}` });

/** Acts as the session runner: answers the next `text` command and returns what would be typed. */
function nextTyped(sid, { ok = true, error } = {}) {
  return (async () => {
    for (const deadline = Date.now() + 10000; Date.now() < deadline; ) {
      const { commands } = await bridge.client.get(`/runner/${sid}/commands?wait=5`, { timeoutMs: 10000 });
      const c = commands.find((x) => x.type === 'text');
      if (c) {
        await bridge.client.post(`/runner/${sid}/command-result`, { id: c.id, ok, error });
        return c.text;
      }
    }
    throw new Error('nothing was typed into the session');
  })();
}

test('parseStartArgs: name, folder and first message', () => {
  assert.deepEqual(parseStartArgs('My Project'), { name: 'My Project', dir: '', prompt: '' });
  assert.deepEqual(parseStartArgs('Site in ~/work/site'), { name: 'Site', dir: '~/work/site', prompt: '' });
  assert.deepEqual(parseStartArgs('Site in ~/work/site: fix the login bug'), { name: 'Site', dir: '~/work/site', prompt: 'fix the login bug' });
  assert.deepEqual(parseStartArgs('Bugs: look at issue 12\nand 13'), { name: 'Bugs', dir: '', prompt: 'look at issue 12\nand 13' });
  assert.deepEqual(parseStartArgs('"Quoted Name"'), { name: 'Quoted Name', dir: '', prompt: '' });
  assert.equal(parseStartArgs(''), null);
  assert.equal(parseStartArgs(': only a message'), null);
  assert.equal(resolveStartDir('', '/base'), '/base');
  assert.equal(resolveStartDir('sub/dir', '/base'), '/base/sub/dir');
  assert.equal(resolveStartDir('/abs', '/base'), '/abs');
});

test('a message in a fresh session group (no question yet) is typed into Claude', async () => {
  const sid = await registerSession(bridge.client, 'Talk Fresh');
  const g = await groupOf(sid);
  await runHook(bridge.home, sid, { hook_event_name: 'SessionStart', source: 'startup' });
  const typed = nextTyped(sid);
  const id = wa.userSays('Explain the structure of this project', { chat: g.jid });
  assert.equal(await typed, 'Explain the structure of this project');
  await waitFor(() => wa.reactions().some((r) => r.id === id && r.emoji === '✅'), { message: '✅ reaction' });
  assert.equal(wa.texts().some((t) => /no open question/i.test(t)), false);
  const audit = bridge.db.auditTail(20).find((e) => e.action === 'prompt.sent' && e.session_id === sid);
  assert.ok(audit, 'audited');
});

test('while Claude is busy the message is queued (Claude Code runs it next)', async () => {
  const sid = await registerSession(bridge.client, 'Talk Busy');
  const g = await groupOf(sid);
  await runHook(bridge.home, sid, { hook_event_name: 'UserPromptSubmit', prompt: 'long task' });
  const typed = nextTyped(sid);
  const id = wa.userSays('also add tests', { chat: g.jid });
  assert.equal(await typed, 'also add tests');
  await waitFor(() => wa.reactions().some((r) => r.id === id && r.emoji === '🕐'), { message: '🕐 reaction' });
  await replyTo(id, /your message is queued/);
});

test('a reply to the group intro message is a prompt, not ignored', async () => {
  const sid = await registerSession(bridge.client, 'Talk Quote');
  const g = await groupOf(sid);
  const intro = await waitFor(() => wa.sent.find((s) => s.jid === g.jid && /Claude - Talk Quote/.test(s.content.text || '')), { message: 'intro' });
  const typed = nextTyped(sid);
  wa.userSays('hello there', { chat: g.jid, quote: intro.key });
  assert.equal(await typed, 'hello there');
});

test('nothing is typed while a permission question waits; the runner refusing is reported', async () => {
  const sid = await registerSession(bridge.client, 'Talk Blocked');
  const g = await groupOf(sid);
  const hook = runHook(bridge.home, sid, permissionEvent('rm -rf build'));
  const q = await pendingQuestion(bridge.client, (x) => x.session_id === sid);
  // Direct router call: a prompt must never be typed over an open permission dialog.
  const r = await bridge.router.sendPrompt({ sessionId: sid, text: 'go on', user: 'whatsapp:+1', viaChannel: 'whatsapp' });
  assert.equal(r.result, 'rejected');
  assert.match(r.reason, new RegExp(`waiting for an answer to ${q.id}`));
  await waitFor(() => wa.sent.find((x) => x.jid === g.jid && x.content.text?.includes(` · ${q.id}`)), { message: 'question in group' });
  wa.userSays('deny', { chat: g.jid });
  await hook;

  const typed = nextTyped(sid, { ok: false, error: 'a menu is showing in the terminal; not typing free text into it' });
  const id = wa.userSays('next step', { chat: g.jid });
  await typed;
  await replyTo(id, /Not sent to Claude: could not type the message: a menu is showing/);
});

test('a message to an ended session says so', async () => {
  const sid = await registerSession(bridge.client, 'Talk Ended');
  const g = await groupOf(sid);
  await bridge.client.post(`/runner/${sid}/exit`, { exitCode: 0 });
  const id = wa.userSays('are you there?', { chat: g.jid });
  await replyTo(id, /Talk Ended\* \(session_\d+\) has ended/);
});

test('/new starts a session in the background (real runner), with its group', async () => {
  const dir = fs.mkdtempSync(path.join(tempHome(), 'proj-'));
  const prev = process.env.BRIDGE_CLAUDE_COMMAND;
  process.env.BRIDGE_CLAUDE_COMMAND = '/bin/sh'; // stands in for claude: an interactive program in the PTY
  try {
    const id = wa.userSays(`/new Remote One in ${dir}`, { chat: MY_JID });
    await replyTo(id, /🚀 Started \*Remote One\*/);
    const s = bridge.db.listSessions({ includeEnded: false }).find((x) => x.project_name === 'Remote One');
    assert.equal(s.cwd, dir);
    const g = await groupOf(s.id);
    assert.equal(wa.groups.find((x) => x.jid === g.jid).subject, 'Claude - Remote One');
    await waitFor(() => bridge.sessions.isConnected(s.id), { message: 'runner heartbeating' });
    process.kill(s.runner_pid, 'SIGHUP'); // an interactive sh ignores SIGTERM
    await waitFor(() => bridge.db.getSession(s.id).ended_at, { message: 'session ended', timeoutMs: 15000 });
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_CLAUDE_COMMAND;
    else process.env.BRIDGE_CLAUDE_COMMAND = prev;
  }
});

test('/new reports errors and can be turned off', async () => {
  const id = wa.userSays('/new Nowhere in /definitely/not/here', { chat: MY_JID });
  await replyTo(id, /Could not start the session: folder not found: \/definitely\/not\/here/);
  const id2 = wa.userSays('/new', { chat: MY_JID });
  await replyTo(id2, /Usage: \*\/new <name>\*/);
  bridge.cfg.whatsapp.remoteStart = false;
  try {
    const id3 = wa.userSays('/new Off', { chat: MY_JID });
    await replyTo(id3, /turned off/);
  } finally {
    bridge.cfg.whatsapp.remoteStart = true;
  }
});
