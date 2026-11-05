// Daemon-side registry of terminal sessions. Session processes are owned by `bridge start` runners
// (one per terminal window), never by the daemon, so restarting the daemon can't kill or duplicate
// Claude sessions. Runners re-attach with their session id after a daemon restart.
import { EventEmitter } from 'node:events';
import { uuid } from '../util/ids.js';

export const ENDED = new Set(['COMPLETED', 'FAILED', 'STOPPED']);

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class SessionManager extends EventEmitter {
  constructor({ db, cfg, logger }) {
    super();
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.queues = new Map(); // sessionId -> { commands: [], waiter: {res, timer} | null }
    this.results = new Map(); // commandId -> { resolve, timer }
  }

  /** Called at daemon start: sessions whose runner died while the daemon was down are marked STOPPED. */
  recover() {
    for (const s of this.db.listSessions({ includeEnded: false })) {
      if (!pidAlive(s.runner_pid)) {
        this.db.updateSession(s.id, { status: 'STOPPED', ended_at: Date.now() });
        this.db.audit({ action: 'session.recovered_as_stopped', sessionId: s.id, detail: { runner_pid: s.runner_pid } });
        this.emit('ended', this.db.getSession(s.id), 'terminated');
      } else {
        this.log.info('session still alive after daemon restart', { session: s.id, runner_pid: s.runner_pid });
      }
    }
  }

  register({ projectName, cwd, command, runnerPid, sessionId, force = false }) {
    if (sessionId) {
      const existing = this.db.getSession(sessionId);
      if (!existing) throw Object.assign(new Error(`unknown session ${sessionId}`), { status: 404 });
      if (!ENDED.has(existing.status) && existing.runner_pid !== runnerPid && pidAlive(existing.runner_pid)) {
        throw Object.assign(new Error(`${sessionId} is still running in another terminal (runner pid ${existing.runner_pid})`), { status: 409 });
      }
      const s = this.db.updateSession(sessionId, {
        runner_pid: runnerPid,
        status: existing.runner_pid === runnerPid && !ENDED.has(existing.status) ? existing.status : 'STARTING',
        ended_at: null,
        exit_code: null,
        exit_signal: null,
        last_heartbeat_at: Date.now(),
        last_activity_at: Date.now(),
      });
      this.db.audit({ action: 'session.reattached', sessionId });
      this.emit('changed');
      return { session: s, reattached: true };
    }
    if (!force) {
      const dup = this.db
        .listSessions({ includeEnded: false })
        .find((s) => s.project_name.toLowerCase() === projectName.toLowerCase() && s.cwd === cwd && pidAlive(s.runner_pid));
      if (dup) {
        throw Object.assign(new Error(`"${projectName}" is already running as ${dup.id} (runner pid ${dup.runner_pid}). Use --new to start another one.`), { status: 409 });
      }
    }
    const s = this.db.createSession({ projectName, cwd, command, runnerPid });
    this.db.audit({ action: 'session.started', sessionId: s.id, detail: { projectName, cwd, command } });
    this.emit('started', s);
    this.emit('changed');
    return { session: s, reattached: false };
  }

  heartbeat(sessionId, { childPid, lastInputAt } = {}) {
    const s = this.require(sessionId);
    const fields = { last_heartbeat_at: Date.now() };
    if (childPid) fields.process_id = childPid;
    if (lastInputAt) fields.last_input_at = lastInputAt;
    if (s.status === 'STARTING' && childPid) fields.status = 'RUNNING';
    this.db.updateSession(sessionId, fields);
  }

  touch(sessionId, fields = {}) {
    const s = this.db.getSession(sessionId);
    if (!s) return null;
    const next = { last_activity_at: Date.now(), ...fields };
    if (!ENDED.has(s.status) && !('status' in fields) && s.status === 'STARTING') next.status = 'RUNNING';
    const updated = this.db.updateSession(sessionId, next);
    this.emit('changed');
    return updated;
  }

  exit(sessionId, { exitCode = null, signal = null, reason = null } = {}) {
    const s = this.require(sessionId);
    if (ENDED.has(s.status)) return s;
    const status = reason === 'terminated' || signal ? 'STOPPED' : exitCode === 0 ? 'COMPLETED' : 'FAILED';
    const updated = this.db.updateSession(sessionId, { status, exit_code: exitCode, exit_signal: signal ? String(signal) : null, ended_at: Date.now(), waiting_prompt: 0 });
    this.db.audit({ action: 'session.ended', sessionId, detail: { status, exitCode, signal, reason } });
    this.flushQueue(sessionId);
    this.emit('ended', updated, status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'terminated');
    this.emit('changed');
    return updated;
  }

  /** Marks sessions whose runner stopped heartbeating and whose process is gone. */
  reapStale(now = Date.now()) {
    for (const s of this.db.listSessions({ includeEnded: false })) {
      const silentFor = now - (s.last_heartbeat_at || s.started_at);
      if (silentFor > this.cfg.sessionStaleSec * 1000 && !pidAlive(s.runner_pid)) {
        this.log.warn('session runner disappeared', { session: s.id });
        this.exit(s.id, { reason: 'terminated' });
      }
    }
  }

  isConnected(sessionId, now = Date.now()) {
    const s = this.db.getSession(sessionId);
    return !!s && !ENDED.has(s.status) && now - (s.last_heartbeat_at || 0) < this.cfg.sessionStaleSec * 1000;
  }

  require(sessionId) {
    const s = this.db.getSession(sessionId);
    if (!s) throw Object.assign(new Error(`unknown session ${sessionId}`), { status: 404 });
    return s;
  }

  // ---------- runner command channel (long-poll) ----------
  queue(sessionId) {
    if (!this.queues.has(sessionId)) this.queues.set(sessionId, { commands: [], waiter: null });
    return this.queues.get(sessionId);
  }

  /** Sends a command to the runner. With `awaitResult`, resolves with the runner's {ok, error}. */
  sendCommand(sessionId, command, { awaitResult = false, timeoutMs = 20000 } = {}) {
    const cmd = { id: uuid(), ...command };
    const q = this.queue(sessionId);
    q.commands.push(cmd);
    this.wakeWaiter(sessionId);
    if (!awaitResult) return Promise.resolve({ ok: true, id: cmd.id });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.results.delete(cmd.id);
        const idx = q.commands.indexOf(cmd);
        if (idx >= 0) q.commands.splice(idx, 1);
        resolve({ ok: false, error: 'session runner did not respond in time' });
      }, timeoutMs);
      this.results.set(cmd.id, { resolve, timer });
    });
  }

  commandResult(id, result) {
    const r = this.results.get(id);
    if (!r) return false;
    clearTimeout(r.timer);
    this.results.delete(id);
    r.resolve(result);
    return true;
  }

  wakeWaiter(sessionId) {
    const q = this.queue(sessionId);
    if (q.waiter && q.commands.length) {
      const { res, timer } = q.waiter;
      q.waiter = null;
      clearTimeout(timer);
      res(q.commands.splice(0));
    }
  }

  pollCommands(sessionId, waitMs, onClose) {
    const q = this.queue(sessionId);
    if (q.commands.length) return Promise.resolve(q.commands.splice(0));
    if (q.waiter) {
      clearTimeout(q.waiter.timer);
      q.waiter.res([]);
    }
    return new Promise((res) => {
      const timer = setTimeout(() => {
        if (q.waiter?.res === res) q.waiter = null;
        res([]);
      }, waitMs);
      q.waiter = { res, timer };
      onClose?.(() => {
        if (q.waiter?.res === res) {
          clearTimeout(timer);
          q.waiter = null;
        }
      });
    });
  }

  flushQueue(sessionId) {
    const q = this.queues.get(sessionId);
    if (!q) return;
    for (const c of q.commands) this.commandResult(c.id, { ok: false, error: 'session ended' });
    q.commands = [];
  }
}
