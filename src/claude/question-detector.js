// Turns Claude Code hook events and PTY screen prompts into bridge questions and session state.
import { buildAskUserQuestion } from '../adapters/ask-user-question.js';
import { buildTurnFinished } from '../adapters/free-text.js';
import { handlePermissionRequest } from './permission-handler.js';
import { extractContext } from './transcript.js';
import { truncate } from '../util/ids.js';

export class QuestionDetector {
  constructor({ db, cfg, logger, questions, sessions, notifier }) {
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.questions = questions;
    this.sessions = sessions;
    this.notifier = notifier;
    this.screen = new Map(); // sessionId -> { fingerprint, questionId, covered:Set, seq, localUntil }
    this.lastPrompt = new Map(); // sessionId -> last prompt you (or the bridge) typed
  }

  /** What was asked and what Claude did since, so emails can be understood on their own. */
  contextFor(sessionId, event) {
    const s = this.db.getSession(sessionId);
    try {
      return extractContext(event.transcript_path, { cwd: event.cwd || s?.cwd || '', fallbackTask: this.lastPrompt.get(sessionId) || '' });
    } catch (err) {
      this.log.debug?.('context extraction failed', { error: err.message });
      return null;
    }
  }

  withContext(spec, sessionId, event) {
    if (spec) spec.payload.context = this.contextFor(sessionId, event);
    return spec;
  }

  screenState(sessionId) {
    if (!this.screen.has(sessionId)) this.screen.set(sessionId, { fingerprint: null, questionId: null, covered: new Set(), seq: 0, localUntil: 0 });
    return this.screen.get(sessionId);
  }

  /**
   * Handles one hook invocation. Resolves with { output } where output is the JSON the hook prints
   * (null = no decision, Claude Code continues with its normal behaviour).
   */
  async handleHook({ sessionId, idempotencyKey, event, onClose }) {
    const session = this.sessions.require(sessionId);
    const name = event.hook_event_name;
    const touch = (fields = {}) => this.sessions.touch(sessionId, fields);
    if (event.session_id && session.claude_session_id !== event.session_id) touch({ claude_session_id: event.session_id });

    switch (name) {
      case 'SessionStart':
        touch({ status: 'RUNNING' });
        return { output: null };

      case 'UserPromptSubmit':
        if (event.prompt) this.lastPrompt.set(sessionId, String(event.prompt));
        touch({ waiting_prompt: 0, status: 'RUNNING' });
        this.questions.resolveFreeTextLocally(sessionId);
        return { output: null };

      case 'Stop': {
        if (event.stop_hook_active) return { output: null };
        touch({ waiting_prompt: 1 });
        // A newer "turn finished" supersedes older ones.
        for (const q of this.questions.pendingForSession(sessionId, ['free_text'])) this.questions.cancel(q.id, 'superseded by a newer turn');
        if (this.cfg.notifications.turnFinished) {
          const spec = this.withContext(buildTurnFinished(event), sessionId, event);
          this.questions.create(spec, { sessionId, dedupeKey: `${sessionId}:stop:${idempotencyKey}` });
        }
        return { output: null };
      }

      case 'Notification': {
        touch();
        if (event.notification_type === 'elicitation_dialog' || event.notification_type === 'elicitation_url_dialog') {
          this.notifier.queue('needs_terminal', sessionId, {
            title: 'Input needed in the terminal',
            text: `An MCP server needs input that can only be given in the terminal: ${truncate(event.message || '', 300)}`,
          });
        }
        return { output: null };
      }

      case 'SessionEnd':
        touch({ waiting_prompt: 0 });
        return { output: null };

      case 'PreToolUse':
        if (event.tool_name !== 'AskUserQuestion') return { output: null };
        touch({ waiting_prompt: 0 });
        return this.waitBlocking(sessionId, idempotencyKey, this.withContext(buildAskUserQuestion(event), sessionId, event), onClose, { takeover: true });

      case 'PermissionRequest': {
        touch({ waiting_prompt: 0 });
        // Claude shows its multiple-choice dialog through the permission flow when the PreToolUse
        // hook didn't answer (e.g. after a local takeover). Treat it as a question, not a permission.
        if (event.tool_name === 'AskUserQuestion') {
          // After a local takeover the same question continues here: the terminal shows Claude's
          // dialog while the already-sent email/Chat question stays answerable. First answer wins.
          const handoff = this.takeHandoff(sessionId);
          if (handoff) return this.attachBlocking(sessionId, handoff, onClose);
          const spec = this.withContext(buildAskUserQuestion(event), sessionId, event);
          if (spec) {
            spec.eventType = 'PermissionRequest:AskUserQuestion';
            spec.payload.via = 'PermissionRequest';
          }
          return this.waitBlocking(sessionId, idempotencyKey, spec, onClose, { takeover: false });
        }
        const decision = handlePermissionRequest(event, { cfg: this.cfg, db: this.db, sessionId });
        if (decision.output) return { output: decision.output };
        return this.waitBlocking(sessionId, idempotencyKey, this.withContext(decision.spec, sessionId, event), onClose, { takeover: false });
      }

      default:
        touch();
        return { output: null };
    }
  }

  async waitBlocking(sessionId, idempotencyKey, spec, onClose, { takeover }) {
    if (!spec) return { output: null };
    const { question, created } = this.questions.create(spec, { sessionId, dedupeKey: `hook:${idempotencyKey}` });
    if (!created) this.log.info('hook reconnected to existing question', { id: question.id });
    // A native dialog for the same request is on screen right now; don't ask about it twice.
    const st = this.screenState(sessionId);
    if (st.questionId) {
      const sq = this.questions.get(st.questionId);
      if (sq?.status === 'PENDING' && Date.now() - sq.created_at < 10000) this.questions.cancel(sq.id, 'superseded by the matching Claude hook question');
      if (st.fingerprint) st.covered.add(st.fingerprint);
      st.questionId = null;
    }
    if (takeover) this.sessions.sendCommand(sessionId, { type: 'hook_wait', questionId: question.id, kind: question.kind });
    const waiting = this.questions.waitForAnswer(question);
    const mine = this.questions.waiters.get(question.id)?.resolve; // this connection's waiter
    if (mine) onClose?.(() => this.questions.hookDisconnected(question.id, mine));
    const output = await waiting;
    if (takeover) this.sessions.sendCommand(sessionId, { type: 'hook_done', questionId: question.id });
    if (output) this.sessions.touch(sessionId, { status: 'RUNNING' });
    return { output };
  }

  /**
   * Local takeover from the runner (a key pressed while Claude's question waits on a remote answer).
   * The PreToolUse hook is released so Claude draws its own dialog in the terminal, but the question
   * is NOT withdrawn: Claude then asks through the PermissionRequest hook, which re-attaches to the
   * same question, so the email/Chat answer still works. Whichever answer comes first wins.
   */
  takeover(sessionId) {
    const released = [];
    const st = this.screenState(sessionId);
    for (const q of this.questions.pendingForSession(sessionId)) {
      if (q.status !== 'PENDING' || !q.payload?.blocking || q.kind !== 'ask_user_question' || q.payload.via === 'PermissionRequest') continue;
      this.db.updateQuestion(q.id, { payload: { ...q.payload, via: 'PermissionRequest' } });
      st.handoff = { questionId: q.id, until: Date.now() + (this.cfg.handoffSec ?? 30) * 1000 };
      this.questions.releaseWaiter(q.id);
      released.push(q.id);
      // If Claude never re-asks through the permission flow, the terminal answered it.
      setTimeout(() => {
        const cur = this.questions.get(q.id);
        if (cur?.status === 'PENDING' && !this.questions.hasWaiter(q.id)) this.questions.resolveLocally(q.id, 'answered in the terminal');
        if (st.handoff?.questionId === q.id) st.handoff = null;
      }, (this.cfg.handoffSec ?? 30) * 1000).unref?.();
    }
    st.localUntil = Date.now() + 120000; // don't report Claude's own dialog as a separate screen prompt
    return released;
  }

  takeHandoff(sessionId) {
    const st = this.screenState(sessionId);
    const h = st.handoff;
    st.handoff = null;
    if (!h || Date.now() > h.until) return null;
    const q = this.questions.get(h.questionId);
    return q?.status === 'PENDING' ? q : null;
  }

  async attachBlocking(sessionId, question, onClose) {
    this.log.info('question continues through the permission dialog', { id: question.id });
    const waiting = this.questions.waitForAnswer(question);
    const mine = this.questions.waiters.get(question.id)?.resolve;
    if (mine) onClose?.(() => this.questions.hookDisconnected(question.id, mine));
    const output = await waiting;
    if (output) this.sessions.touch(sessionId, { status: 'RUNNING' });
    return { output };
  }

  /** The runner reports what interactive prompt (if any) is visible in the terminal. */
  handleScreenPrompt(sessionId, prompt) {
    const st = this.screenState(sessionId);
    if (!prompt) {
      if (st.questionId) {
        const q = this.questions.get(st.questionId);
        if (q?.status === 'PENDING') this.questions.resolveLocally(q.id, 'the prompt left the screen (answered in the terminal)');
      }
      st.fingerprint = null;
      st.questionId = null;
      return { action: 'cleared' };
    }
    if (prompt.fingerprint === st.fingerprint) return { action: 'unchanged', questionId: st.questionId };
    // A different prompt replaced the previous one.
    if (st.questionId) {
      const q = this.questions.get(st.questionId);
      if (q?.status === 'PENDING') this.questions.resolveLocally(q.id, 'the prompt changed on screen');
      st.questionId = null;
    }
    st.fingerprint = prompt.fingerprint;
    if (st.covered.has(prompt.fingerprint)) return { action: 'covered' };
    if (this.questions.hasActiveBlocking(sessionId)) {
      st.covered.add(prompt.fingerprint);
      return { action: 'covered' };
    }
    if (Date.now() < st.localUntil) {
      st.covered.add(prompt.fingerprint);
      return { action: 'local' };
    }
    st.seq += 1;
    const titles = { menu: 'Terminal menu needs a choice', yes_no: 'Terminal needs a yes/no answer', text_prompt: 'Terminal is asking for input' };
    const { question } = this.questions.create(
      {
        kind: prompt.kind,
        eventType: 'PTY',
        title: titles[prompt.kind] || 'Terminal prompt',
        question: truncate(prompt.question, 2000),
        options: prompt.options || [],
        payload: { fingerprint: prompt.fingerprint, cursorIndex: prompt.cursorIndex ?? 0, numbered: !!prompt.numbered, hint: prompt.hint || '', allowText: prompt.kind === 'text_prompt', blocking: false },
      },
      { sessionId, dedupeKey: `${sessionId}:screen:${prompt.fingerprint}:${st.seq}` },
    );
    st.questionId = question.id;
    return { action: 'created', questionId: question.id };
  }
}
