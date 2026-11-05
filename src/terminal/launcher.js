// Starts a session without a terminal window (used by `/new` from WhatsApp). It runs the normal
// `bridge start` runner, so the session behaves exactly like one started by hand: same hooks, same
// questions, and it keeps running if the daemon restarts.
// When tmux is installed, the runner gets its own window in the tmux session `claude-bridge`
// (BRIDGE_TMUX_SESSION), so you can watch and type into it with `tmux attach -t claude-bridge`.
// Without tmux it runs as a detached background process. Either way its screen output is also
// copied to a log file under ~/.claude-chat-bridge/logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../config.js';
import { sleep } from '../util/ids.js';

/** Resolves the folder a remote `/new` asked for: `~`, absolute, or relative to the start folder. */
export function resolveStartDir(requested, baseDir) {
  const base = baseDir || os.homedir();
  if (!requested) return base;
  const expanded = String(requested).trim().replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(base, expanded);
}

/** Quotes a string for /bin/sh. */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** True when the `tmux` binary can be run. */
export function hasTmux(run = execFileSync) {
  try {
    run('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class SessionLauncher {
  constructor({ db, cfg, logger, spawnImpl = spawn, execImpl = execFileSync }) {
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.spawn = spawnImpl;
    this.exec = execImpl;
  }

  /** tmux session name to launch into, or null to run detached in the background. */
  tmuxSession() {
    const name = this.cfg.tmuxSession;
    if (!name) return null;
    if (this._tmux === undefined) {
      this._tmux = hasTmux(this.exec);
      if (!this._tmux) this.log.warn?.('tmux not found; remote sessions run in the background without a terminal (install tmux to watch them)');
    }
    return this._tmux ? name : null;
  }

  /**
   * Opens a new tmux window (creating the session if needed) running `argv`. Returns the pid of the
   * process in the pane, which is the runner itself because the shell `exec`s it.
   */
  launchInTmux(session, windowName, argv, { cwd, env, logFile }) {
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`).join(' ');
    const command = `exec env ${envArgs} ${argv.map(shQuote).join(' ')}`;
    const tmux = (args) => this.exec('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let exists = true;
    try {
      tmux(['has-session', '-t', `=${session}`]);
    } catch {
      exists = false;
    }
    const fmt = ['-P', '-F', '#{pane_id} #{pane_pid}'];
    const out = exists
      ? tmux(['new-window', '-d', '-t', `=${session}:`, '-n', windowName, '-c', cwd, ...fmt, command])
      : tmux(['new-session', '-d', '-s', session, '-n', windowName, '-x', '200', '-y', '50', '-c', cwd, ...fmt, command]);
    const [paneId, pidStr] = out.split(/\s+/);
    try {
      tmux(['pipe-pane', '-t', paneId, `cat >> ${shQuote(logFile)}`]);
    } catch (err) {
      this.log.debug?.('tmux pipe-pane failed', { error: err.message });
    }
    return Number(pidStr);
  }

  /**
   * Launches `bridge start "<name>" --new --cwd <dir> [-- "<first message>"]` in the background and
   * waits until the runner has registered its session. Resolves with { session, logFile }.
   */
  async launch({ name, dir, prompt = '', by = 'unknown', timeoutMs = 20000 }) {
    const projectName = String(name || '').trim().slice(0, 80);
    if (!projectName) throw new Error('give the session a name, e.g. /new My Project');
    const cwd = resolveStartDir(dir, this.cfg.whatsapp?.startDir);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`folder not found: ${cwd}`);

    const logDir = this.cfg.paths.logDir;
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, `remote-session-${Date.now()}.log`);
    const args = [path.join(PROJECT_ROOT, 'bin', 'bridge.js'), 'start', projectName, '--new', '--cwd', cwd];
    if (prompt.trim()) args.push('--', prompt.trim());
    const env = { BRIDGE_HOME: this.cfg.home };

    let runnerPid;
    let exited = null;
    const tmuxSession = this.tmuxSession();
    if (tmuxSession) {
      fs.closeSync(fs.openSync(logFile, 'a', 0o600));
      runnerPid = this.launchInTmux(tmuxSession, projectName, [process.execPath, ...args], { cwd, env, logFile });
    } else {
      const out = fs.openSync(logFile, 'a', 0o600);
      const child = this.spawn(process.execPath, args, {
        cwd,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, ...env },
        windowsHide: true,
      });
      fs.closeSync(out);
      child.unref?.();
      child.on?.('exit', (code) => (exited = code));
      runnerPid = child.pid;
    }
    const where = tmuxSession ? { tmux: tmuxSession } : {};
    this.db.audit({ actor: by, action: 'session.remote_start', detail: { projectName, cwd, runnerPid, ...where } });
    this.log.info('remote session start', { projectName, cwd, runnerPid, by, ...where });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = this.db.listSessions({ includeEnded: false }).find((x) => x.runner_pid === runnerPid);
      if (s) return { session: s, logFile, tmuxSession };
      if (tmuxSession && !pidAlive(runnerPid)) exited = 'unknown';
      if (exited !== null) throw new Error(`the session exited right away (code ${exited}); see ${logFile}`);
      await sleep(200);
    }
    throw new Error(`the session did not start within ${timeoutMs / 1000}s; see ${logFile}`);
  }
}
