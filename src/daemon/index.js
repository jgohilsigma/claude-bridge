// The bridge daemon: one per machine. Owns the SQLite queue, talks to Google Chat (Apps Script)
// and serves the loopback API for hooks and session runners.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { ensureHome, loadConfig, VERSION } from '../config.js';
import { createLogger } from '../logger.js';
import { BridgeDb } from '../database/sqlite.js';
import { SessionManager } from '../terminal/session-manager.js';
import { QuestionQueue } from '../queue/question-queue.js';
import { ResponseRouter } from '../queue/response-router.js';
import { QuestionDetector } from '../claude/question-detector.js';
import { Notifier } from '../google-chat/notifier.js';
import { AppsScriptClient } from '../google-chat/chat-client.js';
import { ChatSync } from '../google-chat/event-handler.js';
import { writeHookSettings } from '../claude/hooks/settings.js';
import { createServer } from './server.js';
import { DaemonClient } from './client.js';
import { WhatsAppConnection } from '../channels/whatsapp/connection.js';
import { WhatsAppChannel } from '../channels/whatsapp/channel.js';

export async function startDaemon({ home, cfg: cfgOverride, logger: loggerOverride, fetchImpl, port = 0, whatsappLoader } = {}) {
  const p = ensureHome(home);
  const cfg = cfgOverride || loadConfig({ home: p.home });
  cfg.version = VERSION;
  cfg.hostname = os.hostname();
  const log = loggerOverride || createLogger({ name: 'daemon', file: p.daemonLog });

  const existing = new DaemonClient(p.home);
  const h = await existing.healthy();
  if (h && h.pid !== process.pid) throw new Error(`a bridge daemon is already running (pid ${h.pid})`);

  const db = new BridgeDb(p.db);
  writeHookSettings(p.hooksSettings, cfg);

  const sessions = new SessionManager({ db, cfg, logger: log.child('sessions') });
  const questions = new QuestionQueue({ db, cfg, logger: log.child('questions'), sessions });
  const notifier = new Notifier({ db, cfg, logger: log.child('notify') });
  const router = new ResponseRouter({ db, cfg, logger: log.child('router'), questions, sessions });
  const detector = new QuestionDetector({ db, cfg, logger: log.child('detector'), questions, sessions, notifier });
  const client = new AppsScriptClient({ url: cfg.appsScriptUrl, secret: cfg.sharedSecret, logger: log.child('apps-script'), fetchImpl });
  const sync = new ChatSync({ db, cfg, logger: log.child('chat'), client, router, questions, notifier });
  const whatsapp = cfg.useWhatsApp
    ? new WhatsAppChannel({ db, cfg, logger: log.child('whatsapp'), router, connection: new WhatsAppConnection({ authDir: cfg.whatsapp.authDir, caFile: cfg.whatsapp.caFile, logger: log.child('whatsapp'), loader: whatsappLoader }) })
    : null;

  sessions.on('ended', (s, how) => notifier.sessionEnded(s, how));
  sessions.on('started', (s) => notifier.sessionStarted(s));
  sessions.on('started', (s) => whatsapp?.onSessionStarted(s));
  sessions.on('changed', () => (sync.sessionsDirty = true));
  questions.on('changed', () => (sync.sessionsDirty = true));
  sessions.recover();

  const token = crypto.randomBytes(32).toString('hex');
  const ctx = { db, cfg, log, sessions, questions, detector, router, sync, whatsapp, token, startedAt: Date.now() };
  const server = createServer(ctx);
  server.requestTimeout = 0; // hooks hold requests open while waiting for answers
  server.headersTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  fs.writeFileSync(p.daemonInfo, JSON.stringify({ pid: process.pid, port: actualPort, token, startedAt: ctx.startedAt, version: VERSION }), { mode: 0o600 });

  const timers = [
    setInterval(() => questions.expireDue(), 5000),
    setInterval(() => sessions.reapStale(), 10000),
  ];
  if (cfg.useRelay) sync.start();
  else if (client.configured) {
    // Email/Chat is off but Apps Script is still set up: tell it to stop emailing (reminders,
    // "bridge offline"…). Any later poll from the bridge turns it back on.
    client
      .call('setActive', { active: false, channels: cfg.channels }, { timeoutMs: 20000 })
      .then(() => log.info('apps script relay paused', { channels: cfg.channels.join(',') }))
      .catch((err) =>
        log.warn('could not pause the Apps Script relay', {
          error: err.message,
          hint: /unknown op/.test(err.message) ? 'update Apps Script to the latest Code.gs and deploy a new version' : undefined,
        }),
      );
  }
  if (whatsapp) await whatsapp.start().catch((err) => log.error('whatsapp start failed', { error: err.message }));
  log.info('daemon started', { pid: process.pid, port: actualPort, channels: cfg.channels.join(',') || 'none', chat: client.configured ? 'configured' : 'not configured' });

  let stopping = false;
  ctx.shutdown = async (reason = 'shutdown') => {
    if (stopping) return;
    stopping = true;
    log.info('daemon stopping', { reason });
    timers.forEach(clearInterval);
    await sync.stop();
    await whatsapp?.stop();
    // Drop hook connections without answering: questions stay PENDING in the DB, hooks keep retrying
    // with the same idempotency key and re-attach when the daemon is back (or fall back to the
    // terminal prompt after ~30s).
    for (const w of questions.waiters.values()) clearTimeout(w.closeTimer);
    questions.waiters.clear();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    try {
      const info = JSON.parse(fs.readFileSync(p.daemonInfo, 'utf8'));
      if (info.pid === process.pid) fs.unlinkSync(p.daemonInfo);
    } catch {
      /* already gone */
    }
    db.close();
    await log.close?.();
  };
  return { ...ctx, port: actualPort, server, shutdown: ctx.shutdown, notifier, client, whatsapp };
}
