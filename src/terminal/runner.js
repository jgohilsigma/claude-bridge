// `bridge start "<project>"`: runs Claude Code (or any interactive command) inside a PTY in the
// current terminal window. The terminal keeps working exactly as before; in addition the runner
//   - registers the session with the daemon and keeps it updated (heartbeats),
//   - injects the bridge hooks via `claude --settings <file>` (user settings stay untouched),
//   - watches the screen for interactive prompts that hooks can't see (menus, y/n),
//   - types answers from Google Chat into the PTY after verifying the prompt is still showing,
//   - lets the person at the keyboard take over any question that is waiting on Google Chat.
import path from 'node:path';
import { ensureDaemon } from '../daemon/client.js';
import { spawnPty, childEnv } from './pty-manager.js';
import { VirtualScreen } from './screen.js';
import { detectPrompt } from './prompt-detector.js';
import { InputInjector } from './input-injector.js';
import { arrowPlan } from '../adapters/terminal-prompts.js';
import { sleep } from '../util/ids.js';

const TAKEOVER_KEY = '\x1c'; // Ctrl+\
const PASS_THROUGH_DURING_WAIT = new Set(['\x1b', '\x03']); // Esc / Ctrl+C still reach Claude
// Terminal reports that are not keystrokes: focus in/out (sent when you switch windows, because
// Claude Code enables focus reporting), mouse reports, and cursor-position/device-attribute replies.
const TERMINAL_REPORT = /^(?:\x1b\[[IO]|\x1b\[<[\d;]+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+R|\x1b\[\?[\d;]*c|\x1b\][\s\S]*?(?:\x07|\x1b\\))+$/;

/** True only for real typing (not focus/mouse/terminal replies). */
export function isUserKeystroke(data) {
  return data.length > 0 && !TERMINAL_REPORT.test(data);
}

export function isClaudeCommand(cmd) {
  return /^claude(\.exe|\.cmd)?$/i.test(path.basename(cmd));
}

export async function runSession({ cfg, projectName, cwd = process.cwd(), command, args = [], sessionId = null, force = false, logger }) {
  const log = logger;
  const cmd = command || cfg.claudeCommand;
  const claude = isClaudeCommand(cmd);
  const out = process.stdout;
  const notice = (msg) => out.write(`\r\n\x1b[36m[bridge]\x1b[0m ${msg}\r\n`);

  let client = await ensureDaemon(cfg.home, { logger: log });
  const reg = await client.post('/sessions/register', { projectName, cwd, command: [cmd, ...args].join(' '), runnerPid: process.pid, sessionId, force });
  const sid = reg.session.id;
  const detectorCfg = { ...cfg.detector, ...reg.detector, textPrompts: claude ? false : !!(reg.detector?.textPrompts ?? cfg.detector.textPrompts) };

  notice(`${reg.reattached ? 'Re-attached' : 'Started'} ${sid} "${projectName}" — questions are forwarded to you (email / Google Chat).`);
  notice('While a question waits for your remote answer, press any key (or Ctrl+\\) to answer it here instead.');

  const cols = out.columns || 120;
  const rows = out.rows || 40;
  const finalArgs = claude ? ['--settings', reg.hooksSettings, ...args] : args;
  const child = spawnPty(cmd, finalArgs, { cwd, cols, rows, env: childEnv({ BRIDGE_SESSION_ID: sid, BRIDGE_HOME: cfg.home }) });
  const screen = new VirtualScreen(cols, rows);
  const injector = new InputInjector((d) => child.write(d), { logger: log });

  let lastInputAt = 0;
  let hookWait = null; // { questionId, kind }
  let reportedFingerprint = null;
  let currentPrompt = null;
  let detectTimer = null;
  let exiting = false;

  const setTitle = (t) => out.write(`\x1b]0;${t}\x07`);
  const baseTitle = `${projectName} (${sid})`;
  setTitle(baseTitle);

  // ---- output: real terminal + virtual screen ----
  child.onData((d) => {
    out.write(d);
    screen.write(d);
    clearTimeout(detectTimer);
    detectTimer = setTimeout(runDetection, detectorCfg.idleMs || 1200);
  });

  async function runDetection() {
    if (!detectorCfg.enabled || exiting) return;
    const prompt = detectPrompt(screen.snapshot(), { textPrompts: detectorCfg.textPrompts });
    currentPrompt = prompt;
    const fp = prompt?.fingerprint || null;
    if (fp === reportedFingerprint) return;
    reportedFingerprint = fp;
    try {
      await client.post('/runner/' + sid + '/screen', { prompt });
    } catch (err) {
      reportedFingerprint = null; // retry on next detection
      log.debug?.('screen report failed', { error: err.message });
    }
  }

  // ---- input: keyboard -> PTY (with local takeover) ----
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onKey = async (buf) => {
    const s = buf.toString('utf8');
    if (!isUserKeystroke(s)) {
      child.write(s); // pass focus/mouse reports through, but they don't mean someone is typing
      return;
    }
    lastInputAt = Date.now();
    if (s === TAKEOVER_KEY || (hookWait && !PASS_THROUGH_DURING_WAIT.has(s))) {
      const had = hookWait;
      hookWait = null;
      setTitle(baseTitle);
      try {
        const r = await client.post(`/runner/${sid}/takeover`, {});
        if (had || r.released?.length) notice('Answer here in the terminal — or from your email/Chat; whichever comes first wins.');
      } catch (err) {
        log.warn?.('takeover failed', { error: err.message });
      }
      return; // the key that triggered the takeover is consumed
    }
    child.write(s);
  };
  stdin.on('data', onKey);

  const onResize = () => {
    const c = out.columns || cols;
    const r = out.rows || rows;
    child.resize(c, r);
    screen.resize(c, r);
  };
  out.on('resize', onResize);

  // ---- command channel from the daemon ----
  async function verifyPrompt(fingerprint) {
    await sleep(50);
    const p = detectPrompt(screen.snapshot(), { textPrompts: detectorCfg.textPrompts });
    if (!p) return { ok: false, error: 'no prompt is showing in the terminal any more' };
    if (p.fingerprint !== fingerprint) return { ok: false, error: 'a different prompt is showing in the terminal now' };
    return { ok: true, prompt: p };
  }

  async function execute(c) {
    switch (c.type) {
      case 'hook_wait':
        hookWait = { questionId: c.questionId, kind: c.kind };
        setTitle(`⏳ ${baseTitle} — waiting for your remote answer (press any key to answer here)`);
        out.write('\x07');
        return { ok: true };
      case 'hook_done':
        if (hookWait?.questionId === c.questionId) hookWait = null;
        setTitle(baseTitle);
        return { ok: true };
      case 'select': {
        const v = await verifyPrompt(c.fingerprint);
        if (!v.ok) return v;
        await injector.sendKeys(arrowPlan(v.prompt.cursorIndex, c.index), async () => (await verifyPrompt(c.fingerprint)).ok || 'prompt changed');
        return { ok: true };
      }
      case 'keys': {
        const v = await verifyPrompt(c.fingerprint);
        if (!v.ok) return v;
        await injector.sendKeys(c.keys, async () => (await verifyPrompt(c.fingerprint)).ok || 'prompt changed');
        return { ok: true };
      }
      case 'text': {
        const verify = () => {
          if (hookWait) return 'Claude is waiting on another question';
          const p = detectPrompt(screen.snapshot(), { textPrompts: false });
          if (c.requireNoMenu && p) return 'a menu is showing in the terminal; not typing free text into it';
          return true;
        };
        await injector.sendText(c.text, verify);
        return { ok: true };
      }
      case 'notice':
        notice(c.text);
        return { ok: true };
      default:
        return { ok: false, error: `unknown command ${c.type}` };
    }
  }

  async function reconnect() {
    for (;;) {
      if (exiting) return;
      try {
        client = await ensureDaemon(cfg.home, { logger: log });
        await client.post('/sessions/register', { projectName, cwd, command: [cmd, ...args].join(' '), runnerPid: process.pid, sessionId: sid });
        await client.post(`/runner/${sid}/heartbeat`, { childPid: child.pid, lastInputAt });
        reportedFingerprint = null;
        runDetection();
        return;
      } catch (err) {
        log.debug?.('reconnect failed', { error: err.message });
        await sleep(2000);
      }
    }
  }

  (async function commandLoop() {
    while (!exiting) {
      try {
        const { commands } = await client.get(`/runner/${sid}/commands?wait=25`, { timeoutMs: 35000 });
        for (const c of commands || []) {
          let result;
          try {
            result = await execute(c);
          } catch (err) {
            result = { ok: false, error: err.message };
          }
          await client.post(`/runner/${sid}/command-result`, { id: c.id, ...result }).catch(() => {});
        }
      } catch (err) {
        if (exiting) return;
        if (err.status === 404 || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENODAEMON') await reconnect();
        else await sleep(1000);
      }
    }
  })();

  const heartbeat = setInterval(async () => {
    try {
      await client.post(`/runner/${sid}/heartbeat`, { childPid: child.pid, lastInputAt });
    } catch {
      /* commandLoop handles reconnection */
    }
  }, (cfg.sessionHeartbeatSec || 5) * 1000);
  client.post(`/runner/${sid}/heartbeat`, { childPid: child.pid, lastInputAt }).catch(() => {});

  // ---- shutdown ----
  const forward = (sig) => () => {
    if (!exiting) child.kill(sig === 'SIGHUP' ? 'SIGHUP' : 'SIGTERM');
  };
  const handlers = { SIGHUP: forward('SIGHUP'), SIGTERM: forward('SIGTERM') };
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);

  return new Promise((resolve) => {
    child.onExit(async ({ exitCode, signal }) => {
      exiting = true;
      clearInterval(heartbeat);
      clearTimeout(detectTimer);
      stdin.off('data', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      out.off('resize', onResize);
      for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
      setTitle('');
      try {
        await client.post(`/runner/${sid}/exit`, { exitCode, signal: signal || null });
      } catch {
        /* daemon will reap the session as STOPPED */
      }
      notice(`${sid} ended (exit code ${exitCode}${signal ? `, signal ${signal}` : ''}).`);
      screen.dispose();
      resolve({ sessionId: sid, exitCode, signal });
    });
  });
}
