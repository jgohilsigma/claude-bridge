// `bridge` command implementations.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig, ensureHome, configProblems, parseEnvFile, envFileFor, setEnvValue, splitList, KNOWN_CHANNELS, RELAY_CHANNELS, PROJECT_ROOT, VERSION } from '../config.js';
import { createLogger } from '../logger.js';
import { DaemonClient, ensureDaemon } from '../daemon/client.js';
import { generateSecret } from '../security/authentication.js';
import { AppsScriptClient } from '../google-chat/chat-client.js';
import { spawnPty } from '../terminal/pty-manager.js';

const pad = (s, n) => String(s ?? '').padEnd(n);
const ago = (ts) => {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function parseArgs(argv) {
  const out = { _: [], flags: {}, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.passthrough = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['new', 'detach', 'all', 'allow', 'deny', 'session', 'send-test', 'force', 'follow', 'f'].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function requireDaemon(cfg) {
  const c = new DaemonClient(cfg.home);
  if (!(await c.healthy())) {
    console.error('The bridge daemon is not running. Start it with `bridge daemon --detach` (or just run `bridge start "<project>"`).');
    process.exit(1);
  }
  return c;
}

/** Opens a TLS connection to WhatsApp to detect firewalls that intercept HTTPS. */
async function probeWhatsAppTls(caFile) {
  const tls = await import('node:tls');
  let ca;
  if (caFile) {
    try {
      ca = [...tls.rootCertificates, fs.readFileSync(caFile, 'utf8')];
    } catch (err) {
      return { ok: false, error: `cannot read BRIDGE_WHATSAPP_CA_FILE: ${err.message}` };
    }
  }
  return new Promise((resolve) => {
    const s = tls.connect({ host: 'web.whatsapp.com', port: 443, servername: 'web.whatsapp.com', ca, timeout: 10000 }, () => {
      s.end();
      resolve({ ok: true });
    });
    s.on('error', (err) => {
      // Look at who issued the certificate, without trusting it.
      const t = tls.connect({ host: 'web.whatsapp.com', port: 443, servername: 'web.whatsapp.com', rejectUnauthorized: false, timeout: 10000 }, () => {
        const cert = t.getPeerCertificate();
        t.end();
        resolve({ ok: false, error: err.message, issuer: [cert?.issuer?.O, cert?.issuer?.CN].filter(Boolean).join(' / ') });
      });
      t.on('error', () => resolve({ ok: false, error: err.message }));
    });
    s.on('timeout', () => {
      s.destroy();
      resolve({ ok: false, error: 'timed out (is WhatsApp blocked on this network?)' });
    });
  });
}

export const commands = {
  async setup(args) {
    const p = ensureHome();
    const env = fs.existsSync(p.env) ? parseEnvFile(fs.readFileSync(p.env, 'utf8')) : {};
    if (!env.BRIDGE_SHARED_SECRET) env.BRIDGE_SHARED_SECRET = generateSecret();
    if (args.flags.url) env.BRIDGE_APPS_SCRIPT_URL = String(args.flags.url);
    if (args.flags.emails) env.BRIDGE_ALLOWED_EMAILS = String(args.flags.emails);
    env.BRIDGE_APPS_SCRIPT_URL ??= '';
    env.BRIDGE_ALLOWED_EMAILS ??= '';
    const text = ['# claude-chat-bridge secrets (keep private)', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ''].join('\n');
    fs.writeFileSync(p.env, text, { mode: 0o600 });
    fs.chmodSync(p.env, 0o600);
    if (!fs.existsSync(p.config)) fs.copyFileSync(`${PROJECT_ROOT}/config/config.example.json`, p.config);
    console.log(`Bridge home: ${p.home}`);
    console.log(`Secrets written to ${p.env} (mode 600).`);
    console.log(`Settings: ${p.config}\n`);
    console.log('Put these values into Apps Script → Project Settings → Script Properties:');
    console.log(`  SHARED_SECRET   = ${env.BRIDGE_SHARED_SECRET}`);
    console.log(`  ALLOWED_EMAILS  = ${env.BRIDGE_ALLOWED_EMAILS || '<your workspace email>'}`);
    if (!env.BRIDGE_APPS_SCRIPT_URL) console.log('\nThen run: bridge setup --url "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec" --emails you@company.com');
  },

  async daemon(args) {
    const cfg = loadConfig();
    if (args.flags.detach) {
      const c = await ensureDaemon(cfg.home);
      console.log(`Bridge daemon running (pid ${c.info.pid}, port ${c.info.port}).`);
      return;
    }
    const { startDaemon } = await import('../daemon/index.js');
    const d = await startDaemon({ home: cfg.home, cfg });
    const stop = (sig) => d.shutdown(sig).then(() => process.exit(0));
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('uncaughtException', (err) => d.log.error('uncaught exception', { error: err.message, stack: err.stack }));
    process.on('unhandledRejection', (err) => d.log.error('unhandled rejection', { error: String(err?.message || err), stack: err?.stack }));
  },

  async stop() {
    const cfg = loadConfig();
    const c = new DaemonClient(cfg.home);
    if (!(await c.healthy())) return console.log('Daemon is not running.');
    await c.post('/shutdown', {});
    console.log('Daemon stopping. Running sessions keep working and re-attach when it starts again.');
  },

  async start(args) {
    const cfg = loadConfig();
    const projectName = args._[0];
    if (!projectName) throw new Error('usage: bridge start "<project name>" [--cwd DIR] [--cmd claude] [--new] [--session session_001] [-- <claude args>]');
    const cwd = args.flags.cwd ? path.resolve(String(args.flags.cwd).replace(/^~(?=$|\/)/, os.homedir())) : process.cwd();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`project folder not found: ${cwd}`);
    const { runSession } = await import('../terminal/runner.js');
    const log = createLogger({ name: 'runner', file: `${cfg.paths.logDir}/runner-${process.pid}.log`, console: false });
    const r = await runSession({
      cfg,
      projectName,
      cwd,
      command: args.flags.cmd ? String(args.flags.cmd) : undefined,
      args: args.passthrough,
      sessionId: args.flags.session ? String(args.flags.session) : null,
      force: !!args.flags.new,
      logger: log,
    });
    await log.close();
    process.exit(r.exitCode ?? 0);
  },

  async sessions(args) {
    const cfg = loadConfig();
    const c = await requireDaemon(cfg);
    const { sessions } = await c.get('/sessions');
    const list = args.flags.all ? sessions : sessions.filter((s) => !s.ended_at || Date.now() - s.ended_at < 24 * 3600 * 1000);
    console.log(`${pad('SESSION ID', 16)} ${pad('PROJECT', 24)} ${pad('STATUS', 10)} ${pad('PID', 8)} LAST ACTIVITY`);
    for (const s of list) console.log(`${pad(s.id, 16)} ${pad(s.project_name.slice(0, 23), 24)} ${pad(s.display_status, 10)} ${pad(s.process_id || '-', 8)} ${ago(s.last_activity_at)}`);
    if (!list.length) console.log('(no sessions)');
  },

  async pending() {
    const cfg = loadConfig();
    const c = await requireDaemon(cfg);
    const { questions } = await c.get('/questions?status=PENDING,ANSWERED');
    if (!questions.length) return console.log('No pending questions.');
    for (const q of questions) {
      console.log(`${q.id}  ${q.session_id}  ${q.kind}  ${q.status}  (${ago(q.created_at)})`);
      console.log(`  ${q.title}: ${q.question.split('\n')[0].slice(0, 100)}`);
      q.options.forEach((o, i) => console.log(`    ${i + 1}. ${o.label}`));
    }
  },

  async history(args) {
    const cfg = loadConfig();
    const c = await requireDaemon(cfg);
    const { questions } = await c.get(`/questions?limit=${Number(args.flags.limit || 30)}`);
    for (const q of questions) {
      const a = q.answer?.summary ? ` → ${q.answer.summary}${q.answer.user ? ` (${q.answer.user})` : ''}` : '';
      console.log(`${new Date(q.created_at).toLocaleString()}  ${q.id}  ${pad(q.session_id, 12)} ${pad(q.status, 16)} ${q.title}${a}`);
    }
  },

  async audit(args) {
    const cfg = loadConfig();
    const c = await requireDaemon(cfg);
    const { entries } = await c.get(`/audit?limit=${Number(args.flags.limit || 40)}`);
    for (const e of entries.reverse()) console.log(`${new Date(e.ts).toISOString()}  ${pad(e.actor, 28)} ${pad(e.action, 28)} ${e.question_id || ''} ${e.session_id || ''} ${e.detail ? JSON.stringify(e.detail) : ''}`);
  },

  /** Answer from this PC: bridge answer <qid> <n|text> | --allow | --deny | --session */
  async answer(args) {
    const cfg = loadConfig();
    const c = await requireDaemon(cfg);
    const [qid, ...rest] = args._;
    if (!qid) throw new Error('usage: bridge answer <questionId> (<option number> | <text> | --allow | --session | --deny)');
    const { questions } = await c.get('/questions?status=PENDING&limit=500');
    const q = questions.find((x) => x.id === qid);
    if (!q) throw new Error(`no pending question ${qid}`);
    let body;
    if (args.flags.allow) body = { type: 'allow', value: { confirmed: true } };
    else if (args.flags.session) body = { type: 'allow_session', value: {} };
    else if (args.flags.deny) body = { type: 'deny', value: { message: rest.join(' ') || undefined } };
    else if (rest.length === 1 && /^\d+$/.test(rest[0]) && q.options.length) body = { type: 'option', value: { index: Number(rest[0]) - 1 } };
    else body = { type: 'text', value: { text: rest.join(' ') } };
    const r = await c.post('/answer', { questionId: qid, sessionId: q.session_id, user: os.userInfo().username, ...body });
    console.log(r.result === 'accepted' ? `Delivered: ${r.summary || ''}` : `Rejected: ${r.reason}`);
  },

  async doctor(args) {
    const cfg = loadConfig();
    const ok = (m) => console.log(`  ✔ ${m}`);
    const bad = (m) => console.log(`  ✘ ${m}`);
    const info = (m) => console.log(`  • ${m}`);
    console.log(`claude-chat-bridge ${VERSION}  (home: ${cfg.home})\n\nLocal environment`);
    const [maj, min] = process.versions.node.split('.').map(Number);
    (maj > 22 || (maj === 22 && min >= 13) ? ok : bad)(`Node.js ${process.versions.node} (need >= 22.13 for node:sqlite)`);
    try {
      ok(`Claude Code: ${execFileSync(cfg.claudeCommand, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim()}`);
    } catch (err) {
      bad(`Claude Code CLI not runnable as "${cfg.claudeCommand}": ${err.message.split('\n')[0]}`);
    }
    try {
      const t = spawnPty(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo pty-ok'] : ['-c', 'echo pty-ok'], { cols: 80, rows: 10, env: process.env });
      const outp = await new Promise((resolve) => {
        let buf = '';
        t.onData((d) => (buf += d));
        t.onExit(() => resolve(buf));
      });
      (outp.includes('pty-ok') ? ok : bad)('PTY (node-pty) can spawn processes');
    } catch (err) {
      bad(`PTY spawn failed: ${err.message}`);
    }
    const problems = configProblems(cfg);
    console.log('\nConfiguration');
    const seen = {};
    for (const f of cfg.envFiles || []) {
      for (const [k, v] of Object.entries(parseEnvFile(fs.readFileSync(f, 'utf8')))) {
        if (seen[k] && seen[k].v !== v && k.startsWith('BRIDGE_')) bad(`${k} differs between ${seen[k].f} and ${f} — the bridge uses the one in ${f}. Keep only one.`);
        seen[k] = { v, f };
      }
    }
    for (const f of cfg.envFiles || []) {
      info(`reading ${f}`);
      try {
        if (process.platform !== 'win32' && fs.statSync(f).mode & 0o077) bad(`${f} is readable by other users: run  chmod 600 "${f}"`);
      } catch {
        /* ignore */
      }
    }
    if (problems.length) problems.forEach(bad);
    else ok(`Apps Script URL set, secret set, ${cfg.allowedEmails.length} allowed email(s)`);
    const d = new DaemonClient(cfg.home);
    const h = await d.healthy();
    console.log('\nChannels');
    info(`BRIDGE_CHANNELS = ${cfg.channels.join(',') || '(none)'}`);
    if (cfg.useWhatsApp) {
      const probe = await probeWhatsAppTls(cfg.whatsapp.caFile);
      if (probe.ok) ok(`can reach WhatsApp securely${cfg.whatsapp.caFile ? ' (using BRIDGE_WHATSAPP_CA_FILE)' : ''}`);
      else {
        bad(`cannot reach WhatsApp securely: ${probe.error}`);
        if (probe.issuer && !/DigiCert|Meta|Facebook|WhatsApp/i.test(probe.issuer)) {
          info(`the connection is intercepted by "${probe.issuer}" (a company firewall inspecting HTTPS). Fix one of:`);
          info('  1) ask IT to exclude *.whatsapp.net and *.whatsapp.com from SSL inspection');
          info('  2) ask IT for the firewall\'s CA certificate (.pem) and set BRIDGE_WHATSAPP_CA_FILE=/path/to/ca.pem in .env');
          info('  3) run the bridge on another network (e.g. phone hotspot or home Wi-Fi)');
        }
      }
    }
    console.log('\nDaemon');
    if (h) {
      ok(`running (pid ${h.pid})`);
      if (cfg.useWhatsApp) {
        const w = h.whatsapp;
        if (!w) bad('WhatsApp enabled in .env but the running bridge started without it: run `node bin/bridge.js stop`');
        else (w.state === 'connected' ? ok : bad)(`WhatsApp: ${w.state}${w.me ? ` (+${w.me.number})` : ''}${w.state === 'not_linked' || w.state === 'logged_out' ? ' — run `node bin/bridge.js whatsapp login`' : ''}`);
      }
      if (cfg.useRelay && h.chat.configured) (h.chat.connected ? ok : bad)(`Google Chat link: ${h.chat.connected ? 'connected' : 'not connected'}${h.chat.lastError ? ` — ${h.chat.lastError}` : ''}`);
    } else info('not running (starts automatically with `bridge start`)');
    if (!cfg.useRelay || !cfg.appsScriptUrl || !cfg.sharedSecret) return;
    if (problems.some((x) => /placeholder/.test(x) && /URL|SECRET/.test(x))) return info('skipping the live Apps Script check until the placeholders above are replaced');
    console.log('\nApps Script / Google Chat');
    const client = new AppsScriptClient({ url: cfg.appsScriptUrl, secret: cfg.sharedSecret });
    try {
      const r = await client.call('ping', { sendTest: !!args.flags['send-test'] }, { timeoutMs: 45000 });
      ok(`web app reachable and signatures verified (script version ${r.version})`);
      const localGs = fs.readFileSync(`${PROJECT_ROOT}/apps-script/Code.gs`, 'utf8').match(/^var VERSION = '([^']+)'/m)?.[1];
      if (localGs && r.version !== localGs) {
        bad(`the deployed script is version ${r.version}, but apps-script/Code.gs is ${localGs}: paste Code.gs, Save, then Deploy → Manage deployments → Edit → Version: New version → Deploy`);
      }
      (r.allowlistCount > 0 ? ok : bad)(`ALLOWED_EMAILS in Script Properties: ${r.allowlistCount} address(es)`);
      (r.spreadsheet ? ok : bad)(`storage spreadsheet: ${r.spreadsheet || 'missing — run setup() once in the Apps Script editor'}`);
      info(`push mode: ${r.pushMode}`);
      if (r.pushMode === 'app') {
        (r.space ? ok : bad)(`Chat space: ${r.space || 'not captured yet — open a DM with "Claude Assistant" and send "help"'}`);
        (r.appAuth?.ok ? ok : bad)(`service-account app authentication: ${r.appAuth?.ok ? 'token obtained' : r.appAuth?.error}`);
      } else if (r.pushMode === 'gmail') {
        ok(`question emails go to ${r.notifyEmail || '(script owner)'}`);
        if (r.mailQuota !== undefined && r.mailQuota !== null) (r.mailQuota > 20 ? ok : bad)(`emails left today (MailApp quota): ${r.mailQuota}`);
        if (Array.isArray(r.triggers)) {
          (r.triggers.includes('gmailPoll') ? ok : bad)(r.triggers.includes('gmailPoll') ? 'email replies are read every minute (gmailPoll trigger)' : 'gmailPoll trigger missing: run `setup` once in the Apps Script editor, otherwise email replies are never read');
        }
        if (r.answerUrl) ok('one-tap answer links enabled (ANSWER_URL set)');
        else info('ANSWER_URL not set: answer by replying to the emails (one-tap links are optional: README → "Gmail setup", step 5)');
      } else if (r.pushMode === 'webhook') {
        (r.webhook ? ok : bad)(`incoming webhook URL ${r.webhook ? 'configured' : 'missing'}`);
      } else bad('no push mode configured: questions are only visible via /pending in Chat');
      if (r.test) (r.test.ok ? ok : bad)(`test message: ${r.test.ok ? 'sent' : r.test.error}`);
      if (r.problems?.length) r.problems.forEach(bad);
    } catch (err) {
      bad(err.message);
    }
  },

  /** bridge channels [list] — show or switch where questions go, e.g. `bridge channels whatsapp`. */
  async channels(args) {
    const cfg = loadConfig();
    const describe = (list) => (list.length ? list.join(', ') : 'none');
    if (!args._[0]) {
      console.log(`Channels: ${describe(cfg.channels)}`);
      console.log(`Set in:   ${envFileFor('BRIDGE_CHANNELS', cfg.home)}`);
      console.log(`\nSwitch with e.g.:\n  node bin/bridge.js channels whatsapp\n  node bin/bridge.js channels gmail\n  node bin/bridge.js channels gmail,whatsapp\nKnown channels: ${KNOWN_CHANNELS.join(', ')}`);
      return;
    }
    const list = [...new Set(splitList(args._.join(',')))];
    const unknown = list.filter((c) => !KNOWN_CHANNELS.includes(c));
    if (unknown.length) throw new Error(`unknown channel(s): ${unknown.join(', ')}. Known: ${KNOWN_CHANNELS.join(', ')}`);
    if (!list.length) throw new Error('give at least one channel, e.g. whatsapp');
    const relay = list.some((c) => RELAY_CHANNELS.includes(c));
    if (relay && !(cfg.appsScriptUrl && cfg.sharedSecret)) throw new Error('email/Chat needs Apps Script: run `bridge setup --url "<apps script /exec url>"` first');

    const file = envFileFor('BRIDGE_CHANNELS', cfg.home);
    setEnvValue(file, 'BRIDGE_CHANNELS', list.join(','));
    console.log(`Channels: ${describe(cfg.channels)} → ${describe(list)}   (saved in ${file})`);
    if (process.env.BRIDGE_CHANNELS !== undefined) console.log(`⚠️  BRIDGE_CHANNELS is also set in your shell (${process.env.BRIDGE_CHANNELS}) and overrides the file. Unset it: unset BRIDGE_CHANNELS`);

    // Email/Chat runs on Apps Script (Google's servers): pause it so it stops emailing on its own.
    if (!relay && cfg.appsScriptUrl && cfg.sharedSecret) {
      try {
        await new AppsScriptClient({ url: cfg.appsScriptUrl, secret: cfg.sharedSecret }).call('setActive', { active: false, channels: list }, { timeoutMs: 30000 });
        console.log('✅ Apps Script paused: no more emails or Chat messages (reminders, "bridge offline"…).');
      } catch (err) {
        if (/unknown op/.test(err.message)) {
          console.log('⚠️  Your Apps Script is an older version and keeps emailing on its own. Update it once:');
          console.log('   copy apps-script/Code.gs into the Apps Script editor → Deploy → Manage deployments → Edit → New version → Deploy.');
        } else console.log(`⚠️  Could not reach Apps Script to pause it (${err.message}). The bridge retries when it starts.`);
      }
    } else if (relay && list.some((c) => ['gchat', 'chat', 'google-chat'].includes(c))) {
      console.log('Note: whether questions arrive as email or Chat cards is set by PUSH_MODE in Apps Script → Script properties.');
    }

    // Restart the daemon so it uses the new channels (running Claude sessions re-attach by themselves).
    const c = new DaemonClient(cfg.home);
    if (await c.healthy()) {
      await c.post('/shutdown', {});
      for (let i = 0; i < 40 && (await c.healthy()); i++) await new Promise((r) => setTimeout(r, 250));
      await ensureDaemon(cfg.home);
      console.log('Bridge restarted with the new channels.');
    } else console.log('The bridge picks up the new channels the next time it starts.');

    if (list.includes('whatsapp')) {
      const st = await (await ensureDaemon(cfg.home)).get('/channels/whatsapp').catch(() => null);
      if (st && (st.state === 'not_linked' || st.state === 'logged_out')) console.log('WhatsApp is not linked yet: node bin/bridge.js whatsapp login');
    }
  },

  /** bridge whatsapp login | status | logout */
  async whatsapp(args) {
    const cfg = loadConfig();
    const sub = args._[0] || 'status';
    if (!cfg.useWhatsApp) {
      console.log('WhatsApp is not enabled. Add it to your .env, e.g.:\n  BRIDGE_CHANNELS=gmail,whatsapp\nthen run: node bin/bridge.js stop   (the bridge restarts with the next command)');
      process.exit(1);
    }
    const c = await ensureDaemon(cfg.home);
    const h = await c.healthy();
    if (!h?.whatsapp) {
      console.log('The running bridge was started before WhatsApp was enabled. Restarting it…');
      await c.post('/shutdown', {});
      await new Promise((r) => setTimeout(r, 1500));
      return commands.whatsapp(args);
    }
    if (sub === 'status') {
      const st = await c.get('/channels/whatsapp');
      console.log(`WhatsApp: ${st.state}${st.me ? ` — linked as +${st.me.number}${st.me.name ? ` (${st.me.name})` : ''}` : ''}`);
      const targets = st.targets || (st.target ? [st.target] : []);
      if (targets.length) {
        const shown = targets.map((t) => (t === st.me?.jid ? 'your own "Message yourself" chat' : `+${t.split('@')[0]}`));
        console.log(`Questions go to: ${shown.join(', ')}`);
      }
      if (st.lastError && st.state !== 'connected') console.log(`Last error: ${st.lastError}`);
      if (st.state === 'not_linked' || st.state === 'logged_out') console.log('Link it with: node bin/bridge.js whatsapp login');
      return;
    }
    if (sub === 'logout') {
      await c.post('/channels/whatsapp/logout', {});
      console.log('WhatsApp unlinked. (You can also remove "Claude Bridge" under WhatsApp → Settings → Linked devices.)');
      return;
    }
    if (sub === 'test') {
      const st = await c.get('/channels/whatsapp');
      if (st.state !== 'connected') throw new Error(`WhatsApp is ${st.state}${st.lastError ? ` (${st.lastError})` : ''}; check: node bin/bridge.js whatsapp status`);
      const r = await c.post('/channels/whatsapp/test', {});
      if (r.groups && !r.results.length) console.log('Group mode is on, but no session is running, so there is no session group to test.\nStart one (node bin/bridge.js start "Session 1"): its group "Claude - Session 1" is created and gets the questions.');
      for (const x of r.results) {
        const who = x.name ? `group "${x.name}"` : x.jid === r.me?.jid ? `+${r.me.number} (your own "Message yourself" chat)` : `+${x.jid.split('@')[0]}`;
        console.log(`${x.ok ? '✅ sent to' : '❌ failed for'} ${who}${x.ok ? '' : `: ${x.error}`}`);
      }
      if (r.results.some((x) => x.ok)) {
        console.log('\n"Sent" means WhatsApp accepted it. If a number still sees nothing, check its "message requests"');
        console.log('and make sure it has saved this linked number as a contact or messaged it once.');
      }
      if (r.results.some((x) => x.jid === r.me?.jid)) console.log('Messages in "Message yourself" usually show no notification: open that chat to see them.');
      if (!r.results.some((x) => x.ok)) process.exitCode = 1;
      return;
    }
    if (sub !== 'login') throw new Error('usage: bridge whatsapp login | status | test | logout');
    const QRCode = (await import('qrcode')).default;
    let st = await c.post('/channels/whatsapp/login', {});
    if (st.state === 'connected') return console.log(`Already linked as +${st.me.number}. To link another phone: node bin/bridge.js whatsapp logout`);
    console.log('On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code:\n');
    let shownQr = null;
    // Terminal QR codes often don't scan (fonts, line spacing, dark themes), so also save a PNG.
    const qrPng = path.join(cfg.home, 'whatsapp-qr.png');
    const removePng = () => fs.rmSync(qrPng, { force: true });
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      st = await c.get('/channels/whatsapp');
      if (st.state === 'connected') {
        removePng();
        console.log(`\n✅ Linked as +${st.me.number}. A welcome message was sent to your "Message yourself" chat.`);
        return;
      }
      if (st.qr && st.qr !== shownQr) {
        shownQr = st.qr;
        await QRCode.toFile(qrPng, st.qr, { width: 400, margin: 4 });
        if (process.platform === 'darwin' && !args.flags['no-open']) {
          try {
            execFileSync('open', [qrPng]);
          } catch {
            /* no GUI: the terminal code and file path are still shown */
          }
        }
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen for the refreshed code
        console.log('On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan:\n');
        console.log(await QRCode.toString(st.qr, { type: 'terminal' }));
        console.log(`Can't scan it? Open the image instead: ${qrPng}`);
        console.log('(the code refreshes every ~20 s; waiting…)');
      }
      if ((st.state === 'not_linked' || st.state === 'logged_out') && shownQr) removePng();
      if (st.state === 'not_linked' || st.state === 'logged_out') throw new Error(`linking stopped (${st.lastError || st.state}); run the command again`);
      if (!shownQr && /certificate/i.test(st.lastError || '')) {
        await c.post('/channels/whatsapp/logout', {}).catch(() => {});
        throw new Error(`cannot reach WhatsApp: ${st.lastError}\nRun: node bin/bridge.js doctor`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('timed out waiting for the QR code to be scanned');
  },

  async logs(args) {
    const cfg = loadConfig();
    const file = cfg.paths.daemonLog;
    if (!fs.existsSync(file)) return console.log('No daemon log yet.');
    const fmt = (l) => {
      try {
        const { ts, level, msg, name, ...rest } = JSON.parse(l);
        const time = new Date(ts).toLocaleTimeString();
        const extra = Object.keys(rest).length ? ' ' + Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
        return `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
      } catch {
        return l;
      }
    };
    const text = fs.readFileSync(file, 'utf8');
    text.trim().split('\n').slice(-Number(args.flags.lines || 60)).forEach((l) => console.log(fmt(l)));
    if (!args.flags.follow && !args.flags.f) return;
    console.log('— following (Ctrl+C to stop) —');
    let pos = Buffer.byteLength(text);
    let partial = '';
    fs.watchFile(file, { interval: 500 }, (cur) => {
      if (cur.size < pos) pos = 0; // log rotated/truncated
      if (cur.size === pos) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(cur.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = cur.size;
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop();
      lines.filter(Boolean).forEach((l) => console.log(fmt(l)));
    });
    await new Promise(() => {});
  },

  help() {
    console.log(`claude-chat-bridge ${VERSION} — remote-control Claude Code sessions from Google Chat

Usage:
  bridge setup [--url <apps script /exec url>] [--emails a@x.com,b@x.com]
  bridge start "<project>" [--cwd DIR] [--cmd claude] [--new] [--session ID] [-- <claude args>]
  bridge sessions [--all]          list sessions
  bridge pending                   list questions waiting for an answer
  bridge answer <qid> <n|text>     answer from this PC (--allow | --session | --deny [reason])
  bridge history [--limit N]       question/answer history
  bridge audit [--limit N]         security audit trail
  bridge daemon [--detach]         run the background daemon (auto-started by 'start')
  bridge stop                      stop the daemon (sessions keep running and re-attach)
  bridge doctor [--send-test]      check Node, Claude, PTY, config and the Google Chat link
  bridge logs [--lines N] [--follow]  show (and follow live) the daemon log
  bridge channels [whatsapp|gmail|gmail,whatsapp]  show or switch where questions go
  bridge whatsapp login|status|test|logout  link WhatsApp (QR code), check it, send a test message, or unlink
`);
  },
};
