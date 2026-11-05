// Small structured logger: human-readable line to stderr (when attached) and JSON line to a file.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /secret|token|password|private_key|authorization/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export function createLogger({ name = 'bridge', file = null, level = process.env.BRIDGE_LOG_LEVEL || 'info', console: toConsole = true } = {}) {
  const min = LEVELS[level] ?? 20;
  let stream = null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  }
  const write = (lvl, msg, data) => {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    const safe = data === undefined ? undefined : redact(data instanceof Error ? { error: data.message, stack: data.stack } : data);
    if (stream) stream.write(JSON.stringify({ ts, level: lvl, name, msg, ...(safe && typeof safe === 'object' ? safe : { data: safe }) }) + '\n');
    if (toConsole) {
      const extra = safe === undefined ? '' : ' ' + JSON.stringify(safe);
      process.stderr.write(`${ts} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}${extra}\n`);
    }
  };
  const logger = {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (sub) => createLoggerFrom(logger, sub),
    close: () => new Promise((r) => (stream ? stream.end(r) : r())),
    _write: write,
  };
  return logger;
}

function createLoggerFrom(parent, sub) {
  const wrap = (lvl) => (m, d) => parent._write(lvl, `${sub}: ${m}`, d);
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'), child: (s) => createLoggerFrom(parent, `${sub}/${s}`), close: parent.close, _write: parent._write };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; }, close: async () => {}, _write() {} };
