// Validates answers coming back from Google Chat and routes them to the originating session.
//
// An answer is only accepted when ALL of these hold:
//   - its response id was never processed before (duplicate protection),
//   - the answering user is on the local allowlist (defense in depth; Apps Script checks too),
//   - the question exists, belongs to the stated session and is still PENDING (no stale answers),
//   - the question has not expired,
//   - the adapter for the question kind accepts the answer (option index, text, confirmation...),
//   - for terminal input: the session is connected and still showing the same prompt.
import { isAllowedUser } from '../security/authentication.js';
import { askUserQuestionOutput } from '../adapters/ask-user-question.js';
import { permissionOutput } from '../adapters/permission.js';
import { freeTextInjection } from '../adapters/free-text.js';
import { menuKeys, yesNoKeys, textPromptKeys } from '../adapters/terminal-prompts.js';

export class ResponseRouter {
  constructor({ db, cfg, logger, questions, sessions }) {
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.questions = questions;
    this.sessions = sessions;
  }

  /** @returns {Promise<{result: 'accepted'|'rejected', reason?: string, questionStatus?: string}>} */
  async handle(resp) {
    const fresh = this.db.insertResponseIfNew({
      id: String(resp.id),
      questionId: String(resp.questionId || ''),
      sessionId: resp.sessionId || null,
      type: String(resp.type || ''),
      value: resp.value ?? null,
      user: resp.user || null,
      createdAt: Number(resp.createdAt) || Date.now(),
    });
    if (!fresh) {
      const prev = this.db.getResponse(String(resp.id));
      if (prev?.processed_at) return { result: prev.result, reason: prev.reason ? `duplicate: ${prev.reason}` : 'duplicate response (already processed)', duplicate: true };
    }
    let outcome;
    try {
      outcome = await this.route(resp);
    } catch (err) {
      this.log.error('routing failed', { response: resp.id, error: err.message });
      outcome = { result: 'rejected', reason: `internal error: ${err.message}` };
    }
    this.db.updateResponse(String(resp.id), { processed_at: Date.now(), result: outcome.result, reason: outcome.reason ?? null });
    this.db.audit({
      actor: resp.user || 'unknown',
      action: `response.${outcome.result}`,
      questionId: resp.questionId,
      sessionId: resp.sessionId,
      detail: { type: resp.type, reason: outcome.reason ?? null, summary: outcome.summary ?? null },
    });
    const q = this.db.getQuestion(String(resp.questionId || ''));
    return { ...outcome, questionStatus: q?.status };
  }

  async route(resp) {
    const rejectWith = (reason) => ({ result: 'rejected', reason });
    // `local` answers come from `bridge answer` over the token-protected loopback API.
    // Trusted without an email check: `bridge answer` on this PC (local) and in-process chat channels
    // that verified the sender themselves (WhatsApp: only your own linked account / configured numbers).
    const trusted = resp.local === true || (resp.viaChannel === 'whatsapp' && this.cfg.useWhatsApp);
    if (!trusted && !isAllowedUser(this.cfg.allowedEmails, resp.user)) return rejectWith(`user ${resp.user || '(unknown)'} is not on the bridge allowlist`);
    const q = this.db.getQuestion(String(resp.questionId || ''));
    if (!q) return rejectWith('unknown question id');
    if (resp.sessionId && resp.sessionId !== q.session_id) return rejectWith(`question ${q.id} belongs to ${q.session_id}, not ${resp.sessionId}`);
    if (q.status !== 'PENDING') return rejectWith(`question is no longer pending (${q.status.toLowerCase().replace('_', ' ')})`);
    if (q.expires_at <= Date.now()) {
      this.questions.expireDue();
      return rejectWith('question expired');
    }
    const response = { type: resp.type, value: resp.value || {} };

    switch (q.kind) {
      case 'ask_user_question':
      case 'permission': {
        const r = q.kind === 'permission' ? permissionOutput(q, response, { user: resp.user }) : askUserQuestionOutput(q, response);
        if (!r.ok) return rejectWith(r.reason);
        const answered = this.questions.markAnswered(q.id, { answer: { ...response, user: resp.user, summary: r.summary }, hookOutput: r.output });
        if (!answered) return rejectWith('question was answered concurrently');
        if (!this.questions.deliverHookOutput(q.id, r.output)) {
          // The hook may be reconnecting after a daemon restart; it picks up hook_output on reconnect.
          this.log.warn('no hook waiting yet; answer stored for pickup', { id: q.id });
        }
        return { result: 'accepted', summary: r.summary };
      }
      case 'free_text': {
        const r = freeTextInjection(q, response);
        if (!r.ok) return rejectWith(r.reason);
        if (r.text === null) {
          this.questions.cancel(q.id, 'dismissed from Google Chat');
          return { result: 'accepted', summary: 'dismissed' };
        }
        if (!this.cfg.allowFreeTextPrompts) return rejectWith('free-text prompts are disabled in the bridge configuration');
        const s = this.db.getSession(q.session_id);
        if (!s?.waiting_prompt) return rejectWith('the session is no longer waiting at the prompt');
        if (!this.sessions.isConnected(q.session_id)) return rejectWith('the session terminal is not connected');
        if (!this.questions.markAnswered(q.id, { answer: { ...response, user: resp.user, summary: r.summary } })) return rejectWith('question was answered concurrently');
        const result = await this.sessions.sendCommand(q.session_id, { type: 'text', questionId: q.id, text: r.text, requireNoMenu: true }, { awaitResult: true });
        if (!result.ok) {
          this.questions.fail(q.id, `could not type the reply: ${result.error}`);
          return rejectWith(`could not type the reply: ${result.error}`);
        }
        this.questions.markDelivered(q.id);
        this.sessions.touch(q.session_id, { waiting_prompt: 0, status: 'RUNNING' });
        return { result: 'accepted', summary: r.summary };
      }
      case 'menu':
      case 'yes_no':
      case 'text_prompt': {
        const r = q.kind === 'menu' ? menuKeys(q, response) : q.kind === 'yes_no' ? yesNoKeys(q, response) : textPromptKeys(q, response);
        if (!r.ok) return rejectWith(r.reason);
        if (r.keys === null) {
          this.questions.cancel(q.id, 'dismissed from Google Chat (prompt left for the terminal)');
          return { result: 'accepted', summary: r.summary };
        }
        if (!this.sessions.isConnected(q.session_id)) return rejectWith('the session terminal is not connected');
        if (!this.questions.markAnswered(q.id, { answer: { ...response, user: resp.user, summary: r.summary } })) return rejectWith('question was answered concurrently');
        const cmd = q.kind === 'menu'
          ? { type: 'select', questionId: q.id, fingerprint: q.payload.fingerprint, index: r.select }
          : { type: 'keys', questionId: q.id, fingerprint: q.payload.fingerprint, keys: r.keys };
        const result = await this.sessions.sendCommand(q.session_id, cmd, { awaitResult: true });
        if (!result.ok) {
          this.questions.fail(q.id, `not typed: ${result.error}`);
          return rejectWith(`not typed into the terminal: ${result.error}`);
        }
        this.questions.markDelivered(q.id);
        return { result: 'accepted', summary: r.summary };
      }
      default:
        return rejectWith(`unsupported question kind ${q.kind}`);
    }
  }
}
