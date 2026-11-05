// Configuration loading: defaults <- config.json <- .env <- process.env.
// Secrets (shared secret) should come from environment variables or the .env file in BRIDGE_HOME,
// both of which are created with 0600 permissions by `bridge setup`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;

export const DEFAULTS = Object.freeze({
  appsScriptUrl: '',
  sharedSecret: '',
  allowedEmails: [],
  // How long a question may stay unanswered before it expires and the terminal falls back to
  // its native prompt. Also drives the Claude hook timeout (questionTimeoutSec + 60).
  questionTimeoutSec: 1800,
  // Long-poll window requested from Apps Script; the bridge reconnects immediately after each poll.
  longPollSec: 20,
  pollIdleDelayMs: 500,
  // Seconds to wait before pushing a question to Chat. If it is answered locally in the meantime,
  // Chat is never bothered.
  pushDelaySec: {
    permission: 5,
    ask_user_question: 5,
    free_text: 20,
    menu: 5,
    yes_no: 5,
    text_prompt: 5,
  },
  // If someone typed in a session's terminal within this many seconds, questions from that session
  // are held back (the person is at the keyboard). 0 disables the presence check.
  localPresenceSec: 20,
  notifications: {
    sessionStarted: false,
    sessionCompleted: true,
    sessionFailed: true,
    turnFinished: true, // Stop hook -> "Claude finished, reply to continue" question
    answerRejected: true,
  },
  detector: {
    enabled: true,
    idleMs: 1200,
    textPrompts: false, // generic "Name: " style free-text prompts (only for non-Claude commands)
  },
  allowFreeTextPrompts: true,
  // Never auto-approve unless the user explicitly adds rules here, e.g.
  // { "tool": "Bash", "pattern": "^npm (test|run lint)$" }. Dangerous operations are never auto-approved.
  autoApprove: { rules: [] },
  extraDangerousPatterns: [],
  claudeCommand: 'claude',
  // tmux session that remote `/new` sessions open a window in (watch with `tmux attach -t <name>`).
  // Empty = run them in the background without a terminal. Ignored when tmux is not installed.
  tmuxSession: 'claude-bridge',
  // Where questions are delivered. Any combination: gmail (or gchat — both go through the Apps Script
  // relay; its PUSH_MODE decides email vs Chat), whatsapp. Empty = gmail when an Apps Script URL is set.
  channels: [],
  whatsapp: {
    to: [], // phone numbers to message (questions go to all; any may answer); empty = your own "Message yourself" chat
    allowed: [], // extra phone numbers allowed to answer (your own number is always allowed)
    groups: false, // one WhatsApp group per session ("Claude - <project>") with the BRIDGE_WHATSAPP_TO numbers
    remoteStart: true, // allow `/new <name>` from WhatsApp to start a Claude session on this PC
    startDir: '', // folder `/new` sessions start in (and relative `in <folder>` resolves against); empty = home
  },
  // After a local takeover, how long to wait for Claude to re-ask through its permission dialog.
  handoffSec: 30,
  sessionHeartbeatSec: 5,
  sessionStaleSec: 45,
});

export function bridgeHome() {
  return process.env.BRIDGE_HOME || path.join(os.homedir(), '.claude-chat-bridge');
}

export function paths(home = bridgeHome()) {
  return {
    home,
    config: path.join(home, 'config.json'),
    env: path.join(home, '.env'),
    db: path.join(home, 'bridge.db'),
    daemonInfo: path.join(home, 'daemon.json'),
    hooksSettings: path.join(home, 'claude-hooks.json'),
    logDir: path.join(home, 'logs'),
    daemonLog: path.join(home, 'logs', 'daemon.log'),
    auditLog: path.join(home, 'logs', 'audit.log'),
  };
}

export function ensureHome(home = bridgeHome()) {
  const p = paths(home);
  fs.mkdirSync(p.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.logDir, { recursive: true, mode: 0o700 });
  return p;
}

/** Minimal .env parser (KEY=VALUE, optional quotes, # comments). */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export const RELAY_CHANNELS = ['gmail', 'email', 'gchat', 'chat', 'google-chat'];
export const KNOWN_CHANNELS = [...RELAY_CHANNELS, 'whatsapp'];

// "+91 98765 43210" stays one number, so only commas/semicolons separate entries.
const phoneList = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((x) => String(x).replace(/\D/g, '')).filter(Boolean))];
const splitList = (s) => String(s || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** .env files, lowest precedence first: <project>/.env, then <BRIDGE_HOME>/.env. Real env vars win. */
export function envFiles(home = bridgeHome(), { includeProjectEnv = true } = {}) {
  const list = includeProjectEnv ? [path.join(PROJECT_ROOT, '.env')] : [];
  list.push(paths(home).env);
  return list.filter((f) => fs.existsSync(f));
}

export { splitList };

/** The .env file that decides `key`: the highest-precedence one that sets it, else <BRIDGE_HOME>/.env. */
export function envFileFor(key, home = bridgeHome()) {
  const files = envFiles(home);
  const setting = files.filter((f) => key in parseEnvFile(fs.readFileSync(f, 'utf8')));
  return setting.length ? setting[setting.length - 1] : paths(home).env;
}

/** Sets KEY=value in an .env file, keeping its comments and other lines (and its file mode). */
export function setEnvValue(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

export function loadConfig({ home = bridgeHome(), env = process.env, includeProjectEnv = true } = {}) {
  const p = paths(home);
  let fileCfg = {};
  if (fs.existsSync(p.config)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(p.config, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON in ${p.config}: ${err.message}`);
    }
  }
  const files = envFiles(home, { includeProjectEnv });
  const fromFiles = Object.assign({}, ...files.map((f) => parseEnvFile(fs.readFileSync(f, 'utf8'))));
  const e = { ...fromFiles, ...env };
  const cfg = deepMerge(structuredClone(DEFAULTS), fileCfg);
  if (e.BRIDGE_APPS_SCRIPT_URL) cfg.appsScriptUrl = e.BRIDGE_APPS_SCRIPT_URL;
  if (e.BRIDGE_SHARED_SECRET) cfg.sharedSecret = e.BRIDGE_SHARED_SECRET;
  if (e.BRIDGE_ALLOWED_EMAILS) cfg.allowedEmails = splitList(e.BRIDGE_ALLOWED_EMAILS);
  if (e.BRIDGE_QUESTION_TIMEOUT_SEC) cfg.questionTimeoutSec = Number(e.BRIDGE_QUESTION_TIMEOUT_SEC);
  if (e.BRIDGE_CLAUDE_COMMAND) cfg.claudeCommand = e.BRIDGE_CLAUDE_COMMAND;
  if (e.BRIDGE_LOCAL_PRESENCE_SEC) cfg.localPresenceSec = Number(e.BRIDGE_LOCAL_PRESENCE_SEC);
  if (e.BRIDGE_CHANNELS !== undefined) cfg.channels = splitList(e.BRIDGE_CHANNELS);
  if (e.BRIDGE_WHATSAPP_TO !== undefined) cfg.whatsapp.to = e.BRIDGE_WHATSAPP_TO;
  if (e.BRIDGE_WHATSAPP_GROUPS !== undefined) cfg.whatsapp.groups = /^(1|on|true|yes)$/i.test(String(e.BRIDGE_WHATSAPP_GROUPS).trim());
  if (e.BRIDGE_WHATSAPP_CA_FILE) cfg.whatsapp.caFile = e.BRIDGE_WHATSAPP_CA_FILE.replace(/^~(?=$|\/)/, os.homedir());
  if (e.BRIDGE_WHATSAPP_REMOTE_START !== undefined && e.BRIDGE_WHATSAPP_REMOTE_START !== '') cfg.whatsapp.remoteStart = !/^(0|off|false|no)$/i.test(String(e.BRIDGE_WHATSAPP_REMOTE_START).trim());
  if (e.BRIDGE_TMUX_SESSION !== undefined) {
    const t = String(e.BRIDGE_TMUX_SESSION).trim();
    cfg.tmuxSession = /^(|0|off|false|no)$/i.test(t) ? '' : t.replace(/[^\w.-]/g, '-');
  }
  if (e.BRIDGE_WHATSAPP_START_DIR) cfg.whatsapp.startDir = path.resolve(e.BRIDGE_WHATSAPP_START_DIR.replace(/^~(?=$|\/)/, os.homedir()));
  if (e.BRIDGE_WHATSAPP_ALLOWED !== undefined) cfg.whatsapp.allowed = splitList(e.BRIDGE_WHATSAPP_ALLOWED).map((x) => x.replace(/\D/g, ''));
  if (e.BRIDGE_PUSH_DELAY_SEC !== undefined && e.BRIDGE_PUSH_DELAY_SEC !== '') {
    const d = Number(e.BRIDGE_PUSH_DELAY_SEC);
    for (const k of Object.keys(cfg.pushDelaySec)) cfg.pushDelaySec[k] = d;
  }
  cfg.allowedEmails = (cfg.allowedEmails || []).map((x) => String(x).toLowerCase());
  if (!cfg.channels || !cfg.channels.length) cfg.channels = cfg.appsScriptUrl ? ['gmail'] : [];
  cfg.channels = [...new Set(cfg.channels.map((c) => String(c).toLowerCase()))];
  cfg.useRelay = cfg.channels.some((c) => RELAY_CHANNELS.includes(c));
  cfg.useWhatsApp = cfg.channels.includes('whatsapp');
  cfg.whatsapp.to = phoneList(cfg.whatsapp.to);
  cfg.whatsapp.authDir = path.join(home, 'whatsapp-auth');
  cfg.home = home;
  cfg.paths = p;
  cfg.envFiles = files;
  return cfg;
}

export function configProblems(cfg) {
  const problems = [];
  for (const c of cfg.channels || []) if (!KNOWN_CHANNELS.includes(c)) problems.push(`unknown channel "${c}" in BRIDGE_CHANNELS (supported: gmail, gchat, whatsapp)`);
  if (cfg.channels && !cfg.useRelay) return problems; // no Apps Script needed
  if (!cfg.appsScriptUrl) problems.push('BRIDGE_APPS_SCRIPT_URL / appsScriptUrl is not set (Google Chat delivery disabled).');
  // Consumer form: /macros/s/<id>/exec. Workspace form: /a/macros/<domain>/s/<id>/exec.
  else if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[^/]+\/exec$/.test(cfg.appsScriptUrl) && !/^http:\/\/127\.0\.0\.1:\d+\//.test(cfg.appsScriptUrl)) {
    problems.push(`appsScriptUrl does not look like an Apps Script web app /exec URL: ${cfg.appsScriptUrl}`);
  }
  if (/REPLACE_WITH/.test(cfg.appsScriptUrl)) problems.push('BRIDGE_APPS_SCRIPT_URL still contains the placeholder from .env.example.');
  if (/REPLACE_WITH/.test(cfg.sharedSecret)) problems.push('BRIDGE_SHARED_SECRET still contains the placeholder from .env.example (run `bridge setup` to generate one).');
  if (cfg.allowedEmails.some((e) => /@yourcompany\.com$|@company\.com$/.test(e))) problems.push('BRIDGE_ALLOWED_EMAILS still contains the example address from .env.example.');
  if (!cfg.sharedSecret) problems.push('BRIDGE_SHARED_SECRET is not set.');
  else if (cfg.sharedSecret.length < 32) problems.push('BRIDGE_SHARED_SECRET must be at least 32 characters.');
  if (!cfg.allowedEmails.length) problems.push('BRIDGE_ALLOWED_EMAILS is empty: every Chat answer will be rejected.');
  return problems;
}
