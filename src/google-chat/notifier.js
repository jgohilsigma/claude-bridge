// Persistent outbox for status notifications (session completed/failed/terminated, rejected
// answers...). Notifications survive restarts and are retried with backoff.
import { uuid } from '../util/ids.js';

export class Notifier {
  constructor({ db, cfg, logger }) {
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
  }

  queue(kind, sessionId, { title, text, id = uuid() }) {
    const s = sessionId ? this.db.getSession(sessionId) : null;
    this.db.queueNotification({ id, kind, sessionId, payload: { id, kind, title, text, sessionId, project: s?.project_name || '' } });
    this.log.info('notification queued', { kind, sessionId });
  }

  sessionEnded(session, how) {
    const n = this.cfg.notifications;
    const map = {
      completed: [n.sessionCompleted, '✅ Session completed', `Claude exited normally (code ${session.exit_code ?? 0}).`],
      failed: [n.sessionFailed, '❌ Session failed', `Claude exited with code ${session.exit_code}.`],
      terminated: [n.sessionFailed, '⚠️ Session terminated', 'The terminal window or process was closed unexpectedly.'],
    };
    const [enabled, title, text] = map[how] || map.terminated;
    if (enabled) this.queue(`session_${how}`, session.id, { title, text, id: `end-${session.id}-${session.ended_at}` });
  }

  sessionStarted(session) {
    if (this.cfg.notifications.sessionStarted) this.queue('session_started', session.id, { title: '▶️ Session started', text: `${session.project_name} is running in ${session.cwd}` });
  }
}
