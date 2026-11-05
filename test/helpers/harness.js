import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { startDaemon } from '../../src/daemon/index.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { silentLogger, createLogger } from '../../src/logger.js';
import { HOOK_SCRIPT } from '../../src/claude/hooks/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
export const OWNER = 'owner@example.com';

export async function startGas({ props = {}, activeUserEmail = '' } = {}) {
  const worker = new Worker(path.join(here, 'gas-worker.js'), {
    workerData: {
      codePath: path.join(ROOT, 'apps-script', 'Code.gs'),
      activeUserEmail,
      props: {
        SHARED_SECRET: SECRET,
        ALLOWED_EMAILS: OWNER,
        SERVICE_ACCOUNT_JSON: JSON.stringify(fakeServiceAccount()),
        CHAT_SPACE: 'spaces/DM123',
        CHAT_SPACE_TYPE: 'DIRECT_MESSAGE',
        SPREADSHEET_ID: 'sheet-1',
        ...props,
      },
    },
  });
  const port = await new Promise((resolve, reject) => {
    worker.once('message', (m) => resolve(m.port));
    worker.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', body: JSON.stringify(body) })).json();
  // Initialise the history spreadsheet like setup() would.
  await post('/__run', { fn: 'setup' });
  return {
    url: `${base}/exec`,
    base,
    chat: async (fn, event, activeUser) => {
      const r = await post('/__chat', { fn, event, activeUser });
      if (r.error) throw new Error(r.error + '\n' + r.stack);
      return r.result;
    },
    state: async () => (await fetch(base + '/__state')).json(),
    offline: (v) => post('/__offline', { offline: v }),
    failChatApi: (v) => post('/__chatapi', { fail: v }),
    setProps: (set, del = []) => post('/__props', { set, del }),
    run: (fn) => post('/__run', { fn }),
    call: (fn, args = [], activeUser) => post('/__call', { fn, args, activeUser }),
    gmailInject: (m) => post('/__gmail', m),
    stop: () => worker.terminate(),
  };
}

let cachedSa;
export function fakeServiceAccount() {
  if (cachedSa) return cachedSa;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  cachedSa = { type: 'service_account', client_email: 'claude-assistant@test.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' };
  return cachedSa;
}
// ---- Chat event builders (Google Workspace add-on format, as delivered to Apps Script) ----
export function addonClick({ email = OWNER, params, form = {}, dialog = false }) {
  return {
    commonEventObject: { hostApp: 'CHAT', parameters: params, formInputs: form },
    chat: {
      user: { name: 'users/111', displayName: 'Owner', email, type: 'HUMAN' },
      eventTime: new Date().toISOString(),
      buttonClickedPayload: { message: { name: 'spaces/DM123/messages/x' }, space: { name: 'spaces/DM123', spaceType: 'DIRECT_MESSAGE' }, isDialogEvent: dialog },
    },
  };
}

export function addonMessage({ email = OWNER, text, space = 'spaces/DM123' }) {
  return {
    commonEventObject: { hostApp: 'CHAT' },
    chat: {
      user: { name: 'users/111', email },
      messagePayload: { space: { name: space, spaceType: 'DIRECT_MESSAGE' }, message: { text, argumentText: text } },
    },
  };
}

export function addonCommand({ email = OWNER, commandId, args = '' }) {
  return {
    commonEventObject: { hostApp: 'CHAT' },
    chat: {
      user: { name: 'users/111', email },
      appCommandPayload: { appCommandMetadata: { appCommandId: commandId, appCommandType: 'SLASH_COMMAND' }, space: { name: 'spaces/DM123', spaceType: 'DIRECT_MESSAGE' }, message: { argumentText: args } },
    },
  };
}

export function legacyClick({ email = OWNER, params, form = {} }) {
  return {
    type: 'CARD_CLICKED',
    user: { name: 'users/111', email },
    space: { name: 'spaces/DM123', type: 'DM' },
    action: { actionMethodName: 'onCardAction', parameters: Object.entries(params).map(([key, value]) => ({ key, value: String(value) })) },
    common: { invokedFunction: 'onCardAction', parameters: params, formInputs: form },
  };
}

export const formText = (v) => ({ stringInputs: { value: [v] } });

// ---- bridge ----
export function tempHome(prefix = 'ccb-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startBridge({ gas, home = tempHome(), overrides = {}, env = {}, whatsappLoader, verbose = !!process.env.TEST_VERBOSE } = {}) {
  const cfg = loadConfig({ home, includeProjectEnv: false, env: { BRIDGE_APPS_SCRIPT_URL: gas ? gas.url : '', BRIDGE_SHARED_SECRET: SECRET, BRIDGE_ALLOWED_EMAILS: OWNER, ...env } });
  Object.assign(cfg, { longPollSec: 1, pollIdleDelayMs: 50, localPresenceSec: 0, sessionStaleSec: 30 }, overrides);
  cfg.pushDelaySec = Object.fromEntries(Object.keys(cfg.pushDelaySec).map((k) => [k, 0]));
  if (overrides.pushDelaySec) Object.assign(cfg.pushDelaySec, overrides.pushDelaySec);
  const logger = verbose ? createLogger({ name: 'daemon', level: 'debug' }) : silentLogger;
  const d = await startDaemon({ home, cfg, logger, whatsappLoader });
  const client = new DaemonClient(home);
  return { ...d, home, cfg, client };
}

export async function registerSession(client, projectName, extra = {}) {
  const r = await client.post('/sessions/register', { projectName, cwd: `/tmp/${projectName}`, command: 'claude', runnerPid: process.pid, force: true, ...extra });
  await client.post(`/runner/${r.session.id}/heartbeat`, { childPid: process.pid });
  return r.session.id;
}

/** Runs the real hook script like Claude Code would. Resolves with parsed stdout JSON (or null). */
export function runHook(home, sessionId, event, { env = {} } = {}) {
  const child = spawn(process.execPath, [HOOK_SCRIPT], { env: { ...process.env, BRIDGE_HOME: home, BRIDGE_SESSION_ID: sessionId ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.stdin.end(JSON.stringify(event));
  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout: out, stderr: err, json: out ? JSON.parse(out) : null }));
  });
  done.child = child;
  return done;
}

export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${message}`);
}

export async function pendingQuestion(client, predicate = () => true) {
  return waitFor(async () => (await client.get('/questions?status=PENDING')).questions.find(predicate), { message: 'pending question' });
}

/** Waits until Apps Script has the question (i.e. it was pushed to Chat). */
export async function chatRecord(gas, qid) {
  return waitFor(async () => {
    const s = await gas.state();
    return s.props[`Q_${qid}`] ? JSON.parse(s.props[`Q_${qid}`]) : null;
  }, { message: `question ${qid} in Apps Script` });
}

export const permissionEvent = (command, extra = {}) => ({
  session_id: 'claude-sess-1',
  hook_event_name: 'PermissionRequest',
  cwd: '/tmp',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command, description: 'test command' },
  ...extra,
});

export const askEvent = (questions) => ({
  session_id: 'claude-sess-1',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 'toolu_' + Math.random().toString(36).slice(2),
  tool_input: { questions },
});
