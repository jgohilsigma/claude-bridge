// Client for the local daemon's loopback API. Used by the CLI, session runners and Claude hooks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, PROJECT_ROOT } from '../config.js';
import { requestJson } from '../util/json-http.js';
import { sleep } from '../util/ids.js';

export function readDaemonInfo(home) {
  try {
    return JSON.parse(fs.readFileSync(paths(home).daemonInfo, 'utf8'));
  } catch {
    return null;
  }
}

export class DaemonClient {
  constructor(home) {
    this.home = home;
    this.info = readDaemonInfo(home);
  }

  refresh() {
    this.info = readDaemonInfo(this.home);
    return this.info;
  }

  async call(method, urlPath, body, { timeoutMs = 10000, signal } = {}) {
    if (!this.info) this.refresh();
    if (!this.info) throw Object.assign(new Error('daemon is not running'), { code: 'ENODAEMON' });
    const { status, body: res } = await requestJson({ port: this.info.port, token: this.info.token, method, path: urlPath, body, timeoutMs, signal });
    if (status >= 400) throw Object.assign(new Error(res?.error || `HTTP ${status}`), { status, body: res });
    return res;
  }

  get(p, opts) {
    return this.call('GET', p, undefined, opts);
  }

  post(p, body, opts) {
    return this.call('POST', p, body, opts);
  }

  async healthy() {
    try {
      this.refresh();
      const h = await this.get('/health', { timeoutMs: 2000 });
      return h?.ok === true ? h : null;
    } catch {
      return null;
    }
  }
}

/** Returns a client for a running daemon, starting one in the background if necessary. */
export async function ensureDaemon(home, { logger, startTimeoutMs = 15000 } = {}) {
  const client = new DaemonClient(home);
  if (await client.healthy()) return client;
  // Tests run their own in-process daemon and must never leave a background one behind.
  if (process.env.BRIDGE_NO_AUTOSTART === '1') throw Object.assign(new Error('daemon is not running (auto-start disabled)'), { code: 'ENODAEMON' });
  const p = paths(home);
  fs.mkdirSync(p.logDir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(p.logDir, 'daemon.stdout.log'), 'a', 0o600);
  logger?.info?.('starting bridge daemon in the background');
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'bridge.js'), 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, BRIDGE_HOME: home },
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await client.healthy()) return client;
  }
  throw new Error(`daemon did not start within ${startTimeoutMs / 1000}s; see ${path.join(p.logDir, 'daemon.stdout.log')}`);
}
