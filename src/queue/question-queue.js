// Question lifecycle:
//
//   PENDING ──chat answer validated──> ANSWERED ──delivered to hook / terminal──> DELIVERED
//      │                                   └──delivery failed──> FAILED
//      ├── answered in the terminal ──> ANSWERED_LOCALLY
//      ├── expired ──> EXPIRED
//      └── dismissed / superseded ──> CANCELLED
//
// Blocking questions (PermissionRequest / AskUserQuestion hooks) keep an HTTP request from the hook
// process open; a "waiter" resolves it with the hook output (or null to fall back to the terminal).
import { EventEmitter } from 'node:events';
import { shortId } from '../util/ids.js';

export const OPEN = ['PENDING', 'ANSWERED'];
export const TERMINAL = ['DELIVERED', 'FAILED', 'ANSWERED_LOCALLY', 'EXPIRED', 'CANCELLED'];

export class QuestionQueue extends EventEmitter {
  constructor({ db, cfg, logger, sessions }) {
    super();
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.sessions = sessions;
    this.waiters = new Map(); // questionId -> { resolve, closeTimer }
    this.bootedAt = Date.now();
  }

  newId() {
    for (let i = 0; i < 20; i++) {
      const id = shortId('q', 5);
      if (!this.db.getQuestion(id)) return id;
    }
    return shortId('q', 8);
  }

  /** Creates (or returns the existing, for the same dedupe key) question. */
  create(spec, { sessionId, dedupeKey = null, now = Date.now() }) {
    if (dedupeKey) {
      const existing = this.db.getQuestionByDedupe(dedupeKey);
      if (existing) return { question: existing, created: false };
    }
    const delay = Number(this.cfg.pushDelaySec?.[spec.kind] ?? 5);
    const q = this.db.insertQuestion({
      id: this.newId(),
      sessionId,
      dedupeKey,
      eventType: spec.eventType,
      kind: spec.kind,
      title: spec.title,
      question: spec.question,
      options: spec.options,
      payload: spec.payload,
      createdAt: now,
      expiresAt: now + this.cfg.questionTimeoutSec * 1000,
      pushAfter: now + Math.max(0, delay) * 1000,
    });
    this.db.audit({ action: 'question.created', questionId: q.id, sessionId, detail: { kind: q.kind, title: q.title } });
    this.log.info('question created', { id: q.id, session: sessionId, kind: q.kind });
    this.emit('changed', q);
    return { question: q, created: true };
  }

  get(id) {
    return this.db.getQuestion(id);
  }

  pendingForSession(sessionId, kinds = null) {
    return this.db.listQuestions({ status: OPEN, sessionId }).filter((q) => !kinds || kinds.includes(q.kind));
  }

  hasActiveBlocking(sessionId) {
    return this.pendingForSession(sessionId).some((q) => q.payload?.blocking);
  }

  /** Waits for a blocking question's hook output. Resolves null on expiry/local answer. */
  waitForAnswer(q) {
    const current = this.db.getQuestion(q.id);
    if (current.status === 'ANSWERED' && current.hook_output) {
      this.markDelivered(q.id);
      return Promise.resolve(current.hook_output);
    }
    if (current.status !== 'PENDING') return Promise.resolve(null);
    const prev = this.waiters.get(q.id);
    if (prev) {
      clearTimeout(prev.closeTimer);
      prev.resolve(null); // superseded by the reconnecting hook
    }
    return new Promise((resolve) => this.waiters.set(q.id, { resolve, closeTimer: null }));
  }

  hasWaiter(id) {
    return this.waiters.has(id);
  }

  /**
   * The hook process's connection closed before an answer was delivered. That means Claude Code
   * killed the hook (the user answered in the terminal, pressed Esc, or the hook timed out).
   */
  hookDisconnected(id, resolveFn) {
    const w = this.waiters.get(id);
    if (!w || w.resolve !== resolveFn) return;
    w.closeTimer = setTimeout(() => {
      if (this.waiters.get(id) !== w) return;
      this.waiters.delete(id);
      const q = this.db.getQuestion(id);
      if (q?.status === 'PENDING') this.resolveLocally(id, 'answered in the terminal (or the hook was cancelled)');
      else if (q?.status === 'ANSWERED') this.fail(id, 'the terminal moved on before the answer could be delivered');
    }, 3000);
  }

  /** Delivers hook output to the waiting hook. Returns true if a hook was waiting. */
  deliverHookOutput(id, output) {
    const w = this.waiters.get(id);
    if (!w) return false;
    clearTimeout(w.closeTimer);
    this.waiters.delete(id);
    w.resolve(output);
    this.markDelivered(id);
    return true;
  }

  markAnswered(id, { answer, hookOutput = null }) {
    const q = this.db.transitionQuestion(id, 'PENDING', 'ANSWERED', { answered_at: Date.now(), answer, hook_output: hookOutput });
    if (q) this.emit('changed', q);
    return q;
  }

  markDelivered(id) {
    const q = this.db.transitionQuestion(id, ['ANSWERED', 'PENDING'], 'DELIVERED', {});
    if (q) {
      this.db.audit({ action: 'question.delivered', questionId: id, sessionId: q.session_id });
      this.emit('changed', q);
    }
    return q;
  }

  fail(id, note) {
    const q = this.db.transitionQuestion(id, OPEN, 'FAILED', { resolution_note: note });
    if (q) {
      this.db.audit({ action: 'question.failed', questionId: id, sessionId: q.session_id, detail: { note } });
      this.emit('changed', q);
    }
    return q;
  }

  resolveLocally(id, note = 'answered in the terminal') {
    const q = this.db.transitionQuestion(id, 'PENDING', 'ANSWERED_LOCALLY', { resolution_note: note });
    if (q) {
      this.releaseWaiter(id);
      this.db.audit({ action: 'question.answered_locally', questionId: id, sessionId: q.session_id, detail: { note } });
      this.emit('changed', q);
    }
    return q;
  }

  cancel(id, note = 'cancelled') {
    const q = this.db.transitionQuestion(id, 'PENDING', 'CANCELLED', { resolution_note: note });
    if (q) {
      this.releaseWaiter(id);
      this.db.audit({ action: 'question.cancelled', questionId: id, sessionId: q.session_id, detail: { note } });
      this.emit('changed', q);
    }
    return q;
  }

  releaseWaiter(id) {
    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.closeTimer);
      this.waiters.delete(id);
      w.resolve(null);
    }
  }

  /** Expires overdue questions; blocking hooks fall back to the native terminal prompt. */
  expireDue(now = Date.now()) {
    for (const q of this.db.listQuestions({ status: 'PENDING', limit: 1000 })) {
      if (q.expires_at <= now) {
        const done = this.db.transitionQuestion(q.id, 'PENDING', 'EXPIRED', { resolution_note: 'no answer before the timeout; the terminal prompt is shown instead' });
        if (done) {
          this.releaseWaiter(q.id);
          this.db.audit({ action: 'question.expired', questionId: q.id, sessionId: q.session_id });
          this.log.info('question expired', { id: q.id });
          this.emit('changed', done);
        }
      }
    }
    // After a daemon restart, blocking questions whose hook never reconnected are orphaned.
    if (now - this.bootedAt > 60000) {
      for (const q of this.db.listQuestions({ status: OPEN, limit: 1000 })) {
        if (q.payload?.blocking && !this.waiters.has(q.id) && q.created_at < this.bootedAt) {
          if (q.status === 'PENDING') this.resolveLocally(q.id, 'the hook did not reconnect after a bridge restart');
          else this.fail(q.id, 'the hook did not reconnect after a bridge restart');
        }
      }
    }
  }

  /** Called when Claude receives a prompt from the keyboard: idle-prompt questions are answered locally. */
  resolveFreeTextLocally(sessionId) {
    for (const q of this.pendingForSession(sessionId, ['free_text'])) {
      if (q.status === 'PENDING') this.resolveLocally(q.id, 'you typed a reply in the terminal');
    }
  }
}
