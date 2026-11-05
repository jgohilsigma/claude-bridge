// WhatsApp delivery channel. Questions go to your own "Message yourself" chat, or to every number in
// BRIDGE_WHATSAPP_TO; any of them answers by replying there. With BRIDGE_WHATSAPP_GROUPS=on each session
// gets its own group ("Claude - <project>") with those numbers, and everything about the session goes there.
// Answers go through the same ResponseRouter as email/Chat answers, so all validation applies and the
// first answer from any platform wins.
import { parseAnswerText } from '../answer-parser.js';
import { presenceHoldUntil } from '../../queue/push-policy.js';
import { displayStatus } from '../../google-chat/message-builder.js';
import { OPEN } from '../../queue/question-queue.js';
import { formatQuestion, formatNotification, botText, isBotText, replyHelp } from './format.js';

export const CHANNEL = 'whatsapp';
const EDIT_WINDOW_MS = 14 * 60 * 1000; // WhatsApp allows edits for 15 minutes
const GROUP_RETRY_MS = 5 * 60 * 1000; // after a failed group creation, fall back to chats for a while
const jidOf = (number) => `${number}@s.whatsapp.net`;
const isGroup = (jid) => String(jid || '').endsWith('@g.us');
const numberOf = (jid) => (String(jid || '').endsWith('@s.whatsapp.net') ? String(jid).split('@')[0].split(':')[0] : null);

function messageText(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg;
  return inner.conversation || inner.extendedTextMessage?.text || '';
}

function quotedId(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg;
  return inner.extendedTextMessage?.contextInfo?.stanzaId || null;
}

export class WhatsAppChannel {
  constructor({ db, cfg, logger, router, connection }) {
    this.db = db;
    this.cfg = cfg;
    this.log = logger;
    this.router = router;
    this.conn = connection;
    this.sentIds = new Set();
    this.startedAt = Date.now();
    this.timer = null;
    this.busy = false;
    this.groupJobs = new Map(); // sessionId -> Promise<jid|null>, so a group is created once
    this.groupFailedAt = new Map();
    this.conn.on('message', (m, type) => this.onMessage(m, type).catch((err) => this.log.error('whatsapp message handling failed', { error: err.message })));
    this.conn.on('open', () => this.onOpen().catch(() => {}));
  }

  async start() {
    await this.conn.start();
    this.timer = setInterval(() => this.tick(), 1500);
  }

  async stop() {
    clearInterval(this.timer);
    await this.conn.stop();
  }

  status() {
    const targets = this.targets();
    return { ...this.conn.status(), target: targets[0] || null, targets };
  }

  /** Chats that receive questions and notifications. */
  targets() {
    const to = this.cfg.whatsapp?.to || [];
    if (to.length) return to.map(jidOf);
    return this.conn.me?.jid ? [this.conn.me.jid] : [];
  }

  get groupMode() {
    return !!this.cfg.whatsapp?.groups;
  }

  async onOpen() {
    if (this.groupMode) return; // everything goes to session groups: no 1-to-1 welcome
    if (this.db.getMeta('whatsapp.welcomed') === this.conn.me?.jid) return;
    this.db.setMeta('whatsapp.welcomed', this.conn.me?.jid || '');
    await this.broadcast(
      '✅ *Claude Assistant is connected to WhatsApp.*\nQuestions from your Claude sessions will appear in this chat. Reply to a question message to answer it.\nCommands: *sessions* · *pending* · *status* · *help*',
    );
  }

  async sendBot(jid, text, opts) {
    const key = await this.conn.sendText(jid, text.startsWith('\u2063') ? text : botText(text), opts);
    if (key?.id) this.sentIds.add(key.id);
    return key;
  }

  /** Called when a new session starts: create its group right away so it shows up on the phone. */
  onSessionStarted(session) {
    if (!this.groupMode || this.conn.state !== 'connected') return;
    this.ensureGroup(session.id).catch(() => {});
  }

  /** The session's group, created on first use. Resolves to null if it can't be created (→ chats). */
  ensureGroup(sessionId) {
    const existing = this.db.whatsAppGroup({ sessionId });
    if (existing) return Promise.resolve(existing.jid);
    if (Date.now() - (this.groupFailedAt.get(sessionId) || 0) < GROUP_RETRY_MS) return Promise.resolve(null);
    if (!this.groupJobs.has(sessionId)) {
      const job = this.createGroup(sessionId)
        .catch((err) => {
          this.groupFailedAt.set(sessionId, Date.now());
          this.log.warn('whatsapp: could not create the session group; using chats', { sessionId, error: err.message });
          return null;
        })
        .finally(() => this.groupJobs.delete(sessionId));
      this.groupJobs.set(sessionId, job);
    }
    return this.groupJobs.get(sessionId);
  }

  async createGroup(sessionId) {
    const session = this.db.getSession(sessionId);
    const subject = `Claude - ${session?.project_name || sessionId}`.slice(0, 100);
    const wanted = (this.cfg.whatsapp?.to || []).filter((n) => n !== this.conn.me?.number);
    const { jid, members } = await this.conn.createGroup(subject, wanted.map(jidOf));
    // Members may be listed by phone number or by LID: keep LID → phone so replies can be checked.
    const lidMap = {};
    const joined = new Set();
    for (const p of members) {
      const phone = numberOf(p.phoneNumber) || numberOf(p.id);
      const lid = [p.lid, p.id].find((x) => String(x || '').endsWith('@lid'));
      if (phone) joined.add(phone);
      if (phone && lid) lidMap[lid] = phone;
    }
    this.db.saveWhatsAppGroup({ sessionId, jid, subject, lidMap });
    this.log.info('whatsapp: session group created', { sessionId, subject, members: joined.size });
    await this.sendBot(
      jid,
      `🤖 *${subject}*\nQuestions and updates from this Claude session (${sessionId}) appear here. Reply to a question message to answer it.\nCommands: *pending* · *sessions* · *status* · *help*`,
    ).catch(() => {});
    // Privacy settings ("who can add me to groups") can block adding someone: send them an invite link.
    const missing = wanted.filter((n) => !joined.has(n));
    if (missing.length && members.length) {
      const link = await this.conn.inviteLink(jid).catch(() => null);
      for (const n of missing) {
        if (!link) break;
        await this.sendBot(jidOf(n), `You're invited to the Claude session group *${subject}*: ${link}`).catch(() => {});
        this.log.info('whatsapp: sent group invite link', { to: n, sessionId });
      }
    }
    return jid;
  }

  /** Where messages about a session go: its group in group mode, otherwise (or as fallback) the chats. */
  async chatsFor(sessionId) {
    if (this.groupMode && sessionId) {
      const g = await this.ensureGroup(sessionId);
      if (g) return [g];
    }
    return this.targets();
  }

  /** Sends to every chat for the session; one unreachable chat doesn't stop the others. Returns the sent keys. */
  async broadcast(text, { sessionId = null } = {}) {
    const keys = [];
    for (const jid of await this.chatsFor(sessionId)) {
      try {
        const key = await this.sendBot(jid, text);
        keys.push({ jid, key });
      } catch (err) {
        this.log.warn('whatsapp: send failed', { to: jid, error: err.message });
      }
    }
    if (!keys.length) throw new Error('could not send to any WhatsApp recipient');
    return keys;
  }

  /** `bridge whatsapp test`: one message to every target (session groups in group mode), with a result each. */
  async sendTest() {
    this.conn.ensureConnected();
    const text = `🧪 *Claude Bridge test message*\nIf you can read this, questions from Claude will reach this chat. Sent ${new Date().toLocaleString()}.`;
    let chats = this.targets();
    const names = {};
    if (this.groupMode) {
      chats = [];
      for (const s of this.db.listSessions({ includeEnded: false })) {
        const g = await this.ensureGroup(s.id);
        if (g) {
          chats.push(g);
          names[g] = this.db.whatsAppGroup({ jid: g })?.subject || g;
        }
      }
    }
    const results = [];
    for (const jid of chats) {
      try {
        const key = await this.sendBot(jid, text);
        results.push({ jid, name: names[jid], ok: true, id: key?.id || null });
      } catch (err) {
        results.push({ jid, name: names[jid], ok: false, error: err.message });
      }
    }
    return { ...this.status(), groups: this.groupMode, results };
  }

  async tick() {
    if (this.busy || this.conn.state !== 'connected' || !this.targets().length) return;
    this.busy = true;
    try {
      await this.pushDue();
      await this.syncStatuses();
      await this.sendNotifications();
    } catch (err) {
      this.log.warn('whatsapp tick failed', { error: err.message });
    } finally {
      this.busy = false;
    }
  }

  async pushDue(now = Date.now()) {
    for (const q of this.db.dueForChannel(CHANNEL, now)) {
      if (presenceHoldUntil(this.db, this.cfg, q, now)) continue;
      const session = this.db.getSession(q.session_id);
      const sent = await this.broadcast(formatQuestion(q, session), { sessionId: q.session_id });
      sent.forEach(({ jid, key }, i) =>
        this.db.recordChannelCopy({ channel: CHANNEL, questionId: q.id, messageId: key?.id || `unknown-${q.id}-${i}`, chatId: key?.remoteJid || jid }),
      );
      const first = sent[0];
      this.db.recordChannelMessage({ channel: CHANNEL, questionId: q.id, messageId: first.key?.id || `unknown-${q.id}-0`, chatId: first.key?.remoteJid || first.jid });
      this.log.info('whatsapp: question sent', { id: q.id, recipients: sent.length });
    }
  }

  /** First answer wins: when a question is resolved elsewhere, every WhatsApp copy of it is updated. */
  async syncStatuses() {
    for (const row of this.db.channelStatusChanges(CHANNEL)) {
      if (row.question_status === 'PENDING') continue;
      const q = this.db.getQuestion(row.question_id);
      const text = formatQuestion(q, this.db.getSession(q.session_id), { status: q.status });
      for (const copy of this.db.channelMessageCopies(CHANNEL, row.question_id)) {
        if (Date.now() - copy.sent_at >= EDIT_WINDOW_MS || String(copy.message_id).startsWith('unknown-')) continue;
        try {
          await this.conn.editText(copy.chat_id, { remoteJid: copy.chat_id, fromMe: true, id: copy.message_id }, text);
        } catch (err) {
          this.log.debug?.('whatsapp edit failed', { error: err.message });
        }
      }
      this.db.markChannelSynced(CHANNEL, row.question_id, row.question_status);
    }
  }

  async sendNotifications() {
    for (const n of this.db.notificationsForChannel(CHANNEL, this.startedAt)) {
      // In group mode everything belongs to a session; the rest (email-side notices) is skipped.
      if (!this.groupMode || n.payload.sessionId) await this.broadcast(formatNotification(n.payload), { sessionId: n.payload.sessionId });
      this.db.markChannelNotification(CHANNEL, n.id);
    }
  }

  /** Phone number of whoever wrote a group message (members may be addressed by LID). */
  groupSenderNumber(m, group) {
    for (const id of [m.key.participant, m.key.participantAlt]) {
      const n = numberOf(id) || group?.lidMap?.[String(id || '').replace(/:\d+@/, '@')];
      if (n) return n;
    }
    return null;
  }

  /** Only your own "Message yourself" chat, the configured numbers and BRIDGE_WHATSAPP_ALLOWED may answer —
   *  in group mode also from inside the session groups this bridge created. */
  isTrustedSender(m) {
    const jid = m.key?.remoteJid || '';
    const allowedNumbers = [...(this.cfg.whatsapp?.to || []), ...(this.cfg.whatsapp?.allowed || [])];
    if (isGroup(jid)) {
      const group = this.db.whatsAppGroup({ jid });
      if (!group) return false; // some other group
      if (m.key.fromMe) return true; // you, on the linked phone
      return allowedNumbers.includes(this.groupSenderNumber(m, group));
    }
    const me = this.conn.me || {};
    const self = [me.jid, me.lid].filter(Boolean);
    if (self.includes(jid)) return m.key.fromMe === true;
    return allowedNumbers.map(jidOf).includes(jid) && !m.key.fromMe;
  }

  async onMessage(m, type) {
    if (!m?.key?.id || this.sentIds.has(m.key.id)) return;
    const text = messageText(m).trim();
    if (!text || isBotText(text)) return; // our own messages echo back in the self chat
    const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) * 1000;
    if (ts && ts < this.startedAt - 60000) return; // history sync, not a new reply
    if (!this.isTrustedSender(m)) {
      if (type === 'notify') this.log.info('whatsapp: ignored message from an untrusted chat', { chat: m.key.remoteJid });
      return;
    }
    const reply = (t) => this.sendBot(m.key.remoteJid, t, { quoted: m }).catch(() => {});
    const cmd = /^\/?(sessions|status|pending|help)$/i.exec(text);
    if (cmd) return reply(this.commandText(cmd[1].toLowerCase()));

    // Which question is this answering? 1) the quoted message, 2) an id prefix, 3) the only open one.
    let q = null;
    let answer = text;
    const quoted = quotedId(m);
    if (quoted) q = this.db.questionForChannelMessage(CHANNEL, quoted);
    const idm = !q && /^(q[a-z0-9]{4,10})\b[\s:,-]*([\s\S]*)$/i.exec(text);
    if (idm) {
      q = this.db.getQuestion(idm[1].toLowerCase());
      answer = idm[2].trim();
    }
    if (!q) {
      if (quoted) return; // a reply to some other message (e.g. a notification): not an answer
      // In a session group, only that session's questions count.
      const group = isGroup(m.key.remoteJid) ? this.db.whatsAppGroup({ jid: m.key.remoteJid }) : null;
      const open = this.db.pendingQuestionsOnChannel(CHANNEL).filter((x) => !group || x.session_id === group.session_id);
      if (open.length === 1) q = open[0];
      else if (!open.length) return reply('There is no open question right now. Send *pending* or *sessions* to check.');
      else return reply(`${open.length} questions are waiting. *Reply to the specific question message* (swipe right on it), or start with its id, e.g. *${open[0].id} 1*.\n${open.map((x) => `• ${x.id} — ${x.title} (${this.db.getSession(x.session_id)?.project_name || x.session_id})`).join('\n')}`);
    }
    if (q.status !== 'PENDING') {
      return reply(`That question (${q.id}) was already handled — ${q.status.toLowerCase().replace('_', ' ')}${q.answer?.summary ? `: ${q.answer.summary}` : ''}. Your reply was *not* sent to Claude.`);
    }
    const parsed = parseAnswerText(q, answer);
    if (parsed.error) return reply(`${parsed.error}\nReply with: ${replyHelp(q)}`);
    const outcome = await this.router.handle({
      id: `wa-${m.key.id}`,
      questionId: q.id,
      sessionId: q.session_id,
      type: parsed.type,
      value: parsed.value,
      user: `whatsapp:+${this.senderNumber(m)}`,
      viaChannel: CHANNEL,
      createdAt: ts || Date.now(),
    });
    if (outcome.result === 'accepted') {
      await this.conn.react(m.key.remoteJid, m.key, '✅').catch(() => {});
    } else {
      await reply(`⚠️ Not delivered: ${outcome.reason}`);
    }
  }

  /** Who answered: your own number for the self chat, otherwise the chat's number. */
  senderNumber(m) {
    const jid = m.key.remoteJid || '';
    const self = [this.conn.me?.jid, this.conn.me?.lid].filter(Boolean);
    if (self.includes(jid) || m.key.fromMe) return this.conn.me?.number || 'unknown';
    if (isGroup(jid)) return this.groupSenderNumber(m, this.db.whatsAppGroup({ jid })) || 'unknown';
    return jid.split('@')[0] || 'unknown';
  }

  commandText(cmd) {
    if (cmd === 'help') {
      return '*Claude Assistant on WhatsApp*\n• Reply to a question message to answer it (*1*, *allow*, *deny reason*, or any text)\n• *pending* — open questions\n• *sessions* — Claude sessions and their state\n• *status* — bridge status\nAnswers only ever go to an existing open question.';
    }
    if (cmd === 'pending') {
      const open = this.db.listQuestions({ status: 'PENDING', limit: 20 });
      if (!open.length) return '🎉 No open questions.';
      return `*Open questions*\n${open.map((q) => `• *${q.id}* — ${q.title} (${this.db.getSession(q.session_id)?.project_name || q.session_id})`).join('\n')}\nReply to the question message, or send e.g. *${open[0].id} 1*.`;
    }
    const open = this.db.listQuestions({ status: OPEN, limit: 500 });
    const sessions = this.db.listSessions().filter((s) => !s.ended_at || Date.now() - s.ended_at < 12 * 3600 * 1000);
    if (cmd === 'status') return `*Bridge status*\n🟢 Online · ${sessions.filter((s) => !s.ended_at).length} active session(s) · ${open.filter((q) => q.status === 'PENDING').length} open question(s)`;
    const icon = { RUNNING: '🟢', WAITING: '🟡', IDLE: '⚪', STARTING: '🔵', COMPLETED: '✅', FAILED: '❌', STOPPED: '⏹️' };
    if (!sessions.length) return 'No sessions. Start one on your PC with `bridge start "Project"`.';
    return `*Sessions*\n${sessions.map((s) => {
      const st = displayStatus(s, open.filter((q) => q.session_id === s.id).length);
      return `${icon[st] || '•'} *${s.project_name}* — ${st} (${s.id})`;
    }).join('\n')}`;
  }
}
