// Loopback-only HTTP API used by hooks, session runners and the CLI. Bound to 127.0.0.1 and
// protected by a random bearer token stored in daemon.json (mode 0600).
import http from 'node:http';
import { readBody, sendJson } from '../util/json-http.js';
import { checkBearer } from '../security/authentication.js';
import { OPEN } from '../queue/question-queue.js';
import { displayStatus } from '../google-chat/message-builder.js';

export function createServer(ctx) {
  const { db, cfg, log, sessions, questions, detector, router, sync, whatsapp, token } = ctx;
  const needWhatsApp = () => {
    if (!whatsapp) throw Object.assign(new Error('WhatsApp is not enabled: add whatsapp to BRIDGE_CHANNELS (e.g. BRIDGE_CHANNELS=gmail,whatsapp) and restart the bridge (bridge stop)'), { status: 409 });
    return whatsapp;
  };

  const routes = [
    ['GET', /^\/health$/, async () => ({
      ok: true,
      pid: process.pid,
      version: cfg.version,
      startedAt: ctx.startedAt,
      chat: { configured: sync.client.configured, connected: sync.connected, lastError: sync.lastError, lastPollAt: sync.lastPollAt },
      channels: cfg.channels,
      whatsapp: whatsapp ? (({ qr, ...rest }) => rest)(whatsapp.status()) : null,
    })],

    ['GET', /^\/channels\/whatsapp$/, async () => needWhatsApp().status()],
    ['POST', /^\/channels\/whatsapp\/login$/, async () => {
      const w = needWhatsApp();
      if (w.conn.state !== 'connected') await w.conn.start({ allowQr: true });
      return w.status();
    }],
    ['POST', /^\/channels\/whatsapp\/test$/, async () => needWhatsApp().sendTest()],
    ['POST', /^\/channels\/whatsapp\/logout$/, async () => {
      const w = needWhatsApp();
      await w.conn.logout();
      return w.status();
    }],

    ['POST', /^\/sessions\/register$/, async (req, body) => {
      const r = sessions.register({ projectName: String(body.projectName || '').trim() || 'Unnamed', cwd: body.cwd, command: body.command, runnerPid: Number(body.runnerPid), sessionId: body.sessionId, force: !!body.force });
      sync.sessionsDirty = true;
      return { session: r.session, reattached: r.reattached, hooksSettings: cfg.paths.hooksSettings, detector: cfg.detector };
    }],

    ['GET', /^\/sessions$/, async () => {
      const open = db.listQuestions({ status: OPEN, limit: 1000 });
      return {
        sessions: db.listSessions().map((s) => ({ ...s, display_status: displayStatus(s, open.filter((q) => q.session_id === s.id).length), connected: sessions.isConnected(s.id) })),
      };
    }],

    ['POST', /^\/runner\/([\w-]+)\/heartbeat$/, async (req, body, [, sid]) => {
      sessions.heartbeat(sid, { childPid: body.childPid, lastInputAt: body.lastInputAt });
      return { ok: true };
    }],

    ['POST', /^\/runner\/([\w-]+)\/exit$/, async (req, body, [, sid]) => {
      const s = sessions.exit(sid, { exitCode: body.exitCode ?? null, signal: body.signal || null, reason: body.reason || null });
      for (const q of questions.pendingForSession(sid)) {
        if (q.status === 'PENDING') questions.cancel(q.id, 'the session ended');
        else questions.fail(q.id, 'the session ended');
      }
      sync.sessionsDirty = true;
      return { session: s };
    }],

    ['GET', /^\/runner\/([\w-]+)\/commands$/, async (req, body, [, sid], url, res) => {
      sessions.require(sid);
      const wait = Math.min(30000, Math.max(0, Number(url.searchParams.get('wait') || 25) * 1000));
      const commands = await sessions.pollCommands(sid, wait, (fn) => res.on('close', fn));
      return { commands };
    }],

    ['POST', /^\/runner\/([\w-]+)\/command-result$/, async (req, body) => ({ ok: sessions.commandResult(String(body.id), { ok: !!body.ok, error: body.error || null }) })],

    ['POST', /^\/runner\/([\w-]+)\/screen$/, async (req, body, [, sid]) => {
      sessions.require(sid);
      const r = detector.handleScreenPrompt(sid, body.prompt || null);
      if (r.action === 'created') sync.schedulePush(50);
      return r;
    }],

    ['POST', /^\/runner\/([\w-]+)\/takeover$/, async (req, body, [, sid]) => {
      const released = detector.takeover(sid);
      log.info('local takeover', { session: sid, released });
      return { released };
    }],

    ['POST', /^\/hook$/, async (req, body, m, url, res) => {
      const { sessionId, idempotencyKey, event } = body;
      if (!sessionId || !idempotencyKey || !event?.hook_event_name) throw Object.assign(new Error('bad hook request'), { status: 400 });
      const r = await detector.handleHook({ sessionId, idempotencyKey: String(idempotencyKey), event, onClose: (fn) => res.on('close', () => { if (!res.writableEnded) fn(); }) });
      sync.sessionsDirty = true;
      sync.schedulePush(event.hook_event_name === 'Stop' ? 1000 : 50);
      return r;
    }],

    ['GET', /^\/questions$/, async (req, body, m, url) => {
      const status = url.searchParams.get('status');
      return { questions: db.listQuestions({ status: status ? status.split(',') : null, limit: Number(url.searchParams.get('limit') || 50) }) };
    }],

    // Local answer path (CLI `bridge answer`), validated exactly like a Chat answer.
    ['POST', /^\/answer$/, async (req, body) => router.handle({ ...body, id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, user: `local:${body.user || 'cli'}`, local: true })],

    ['GET', /^\/audit$/, async (req, body, m, url) => ({ entries: db.auditTail(Number(url.searchParams.get('limit') || 50)) })],

    ['POST', /^\/shutdown$/, async () => {
      setTimeout(() => ctx.shutdown('requested via CLI'), 50);
      return { ok: true };
    }],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!checkBearer(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) return sendJson(res, 404, { error: 'not found' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await route[2](req, body, route[1].exec(url.pathname), url, res);
      sendJson(res, 200, out ?? {});
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error('request failed', { path: url.pathname, error: err.message, stack: err.stack });
      sendJson(res, status, { error: err.message });
    }
  });
}
