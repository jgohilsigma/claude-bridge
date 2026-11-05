// Synchronizes local state with Google Chat (via Apps Script):
//   - push loop: new questions, question status changes, notifications, session snapshots
//   - poll loop: long-polls answers, routes them, acknowledges results
// Every step is persistent and idempotent, so network outages only delay delivery.
import { questionForChat, statusForChat, sessionsForChat } from './message-builder.js';
import { sleep } from '../util/ids.js';
import { OPEN } from '../queue/question-queue.js';

export class ChatSync {
  constructor({ db, cfg, logger, client, router, questions, notifier }) {
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.client = client;
    this.router = router;
    this.questions = questions;
    this.notifier = notifier;
    this.running = false;
    this.connected = null;
    this.lastError = null;
    this.lastPollAt = null;
    this.sessionsDirty = true;
    this.lastSessionSync = 0;
    this.pushTimer = null;
  }

  start() {
    if (!this.client.configured) {
      this.log.warn('Google Chat not configured: questions stay local (use `bridge setup`)');
      return;
    }
    this.running = true;
    this.pollPromise = this.pollLoop();
    this.schedulePush(100);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.pushTimer);
    this.abortWait?.();
  }

  setConnected(ok, err) {
    if (this.connected !== ok) this.log[ok ? 'info' : 'warn'](ok ? 'connected to Apps Script' : 'lost connection to Apps Script', err ? { error: err.message } : undefined);
    this.connected = ok;
    this.lastError = ok ? null : err?.message || String(err);
  }

  schedulePush(ms = 1000) {
    clearTimeout(this.pushTimer);
    if (!this.running) return;
    this.pushTimer = setTimeout(async () => {
      try {
        await this.pushOnce();
      } catch (err) {
        this.log.warn('push cycle failed', { error: err.message });
      }
      this.schedulePush(1000);
    }, ms);
  }

  presenceHold(q, now) {
    const presence = (this.cfg.localPresenceSec || 0) * 1000;
    if (!presence) return null;
    const s = this.db.getSession(q.session_id);
    if (s?.last_input_at && now - s.last_input_at < presence) return s.last_input_at + presence;
    return null;
  }

  async pushOnce(now = Date.now()) {
    // 1. New questions.
    const due = [];
    for (const q of this.db.dueForPush(now)) {
      const hold = this.presenceHold(q, now);
      if (hold) {
        this.db.updateQuestion(q.id, { next_push_at: hold });
        continue;
      }
      due.push(q);
    }
    if (due.length) {
      try {
        const sessions = new Map();
        const items = due.map((q) => {
          if (!sessions.has(q.session_id)) sessions.set(q.session_id, this.db.getSession(q.session_id));
          return questionForChat(q, sessions.get(q.session_id));
        });
        const res = await this.client.call('upsertQuestions', { questions: items });
        const results = new Map((res.results || []).map((r) => [r.id, r]));
        for (const q of due) {
          const r = results.get(q.id);
          if (r?.ok) this.db.updateQuestion(q.id, { pushed_at: Date.now(), push_error: r.warning || null, push_attempts: q.push_attempts + 1 });
          else this.backoffQuestion(q, r?.error || 'no result');
        }
        this.setConnected(true);
      } catch (err) {
        for (const q of due) this.backoffQuestion(q, err.message);
        this.setConnected(false, err);
        return;
      }
    }
    // 2. Status changes (answered locally, delivered, expired...) so Chat cards stay accurate.
    const changed = this.db.unsyncedStatuses();
    if (changed.length) {
      try {
        await this.client.call('updateQuestions', { updates: changed.map(statusForChat) });
        for (const q of changed) this.db.updateQuestion(q.id, { chat_synced_status: q.status });
      } catch (err) {
        this.setConnected(false, err);
        return;
      }
    }
    // 3. Notifications.
    const notes = this.db.dueNotifications(now);
    if (notes.length) {
      try {
        await this.client.call('notify', { events: notes.map((n) => n.payload) });
        for (const n of notes) this.db.markNotification(n.id, { sent_at: Date.now(), attempts: n.attempts + 1, error: null });
      } catch (err) {
        for (const n of notes) this.db.markNotification(n.id, { attempts: n.attempts + 1, error: err.message, next_attempt_at: Date.now() + Math.min(300000, 2000 * 2 ** n.attempts) });
        this.setConnected(false, err);
        return;
      }
    }
    // 4. Session snapshot for /sessions and /status.
    if (this.sessionsDirty || now - this.lastSessionSync > 30000) {
      try {
        await this.client.call('syncSessions', { sessions: this.sessionSnapshot(), bridge: { version: this.cfg.version, host: this.cfg.hostname } });
        this.sessionsDirty = false;
        this.lastSessionSync = now;
      } catch (err) {
        this.setConnected(false, err);
      }
    }
  }

  sessionSnapshot() {
    const open = this.db.listQuestions({ status: OPEN, limit: 1000 });
    const sessions = this.db.listSessions().filter((s) => !s.ended_at || Date.now() - s.ended_at < 24 * 3600 * 1000);
    return sessionsForChat(sessions, open);
  }

  backoffQuestion(q, error) {
    const attempts = q.push_attempts + 1;
    const delay = Math.min(300000, 2000 * 2 ** Math.min(attempts, 8));
    this.db.updateQuestion(q.id, { push_attempts: attempts, push_error: error, next_push_at: Date.now() + delay });
    this.log.warn('question push failed; will retry', { id: q.id, attempts, retryInMs: delay, error });
  }

  async ackPending() {
    const unacked = this.db.unackedResponses();
    if (!unacked.length) return;
    await this.client.call('ack', {
      acks: unacked.map((r) => ({ id: r.id, questionId: r.question_id, result: r.result, reason: r.reason || '', questionStatus: this.db.getQuestion(r.question_id)?.status || null })),
    });
    for (const r of unacked) this.db.updateResponse(r.id, { acked_at: Date.now() });
  }

  async pollLoop() {
    let failures = 0;
    while (this.running) {
      try {
        await this.ackPending();
        const res = await this.client.call('poll', { wait: this.cfg.longPollSec }, { timeoutMs: (this.cfg.longPollSec + 30) * 1000 });
        this.lastPollAt = Date.now();
        this.setConnected(true);
        failures = 0;
        for (const r of res.responses || []) {
          const outcome = await this.router.handle({ ...r, local: false, viaChannel: undefined }); // never trust remote flags
          this.log.info('answer processed', { response: r.id, question: r.questionId, result: outcome.result, reason: outcome.reason });
          if (outcome.result === 'rejected' && !outcome.duplicate && this.cfg.notifications.answerRejected) {
            this.notifier.queue('answer_rejected', r.sessionId || null, { title: '⚠️ Answer not delivered', text: `Your answer to ${r.questionId} was not delivered: ${outcome.reason}` });
          }
        }
        await this.ackPending();
        if (res.responses?.length) this.schedulePush(50);
        await sleep(this.cfg.pollIdleDelayMs);
      } catch (err) {
        failures++;
        this.setConnected(false, err);
        const delay = err.retryable === false ? 60000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
        this.log.warn('poll failed; retrying', { error: err.message, retryInMs: delay });
        await new Promise((r) => {
          const t = setTimeout(r, delay);
          this.abortWait = () => {
            clearTimeout(t);
            r();
          };
        });
      }
    }
  }
}
