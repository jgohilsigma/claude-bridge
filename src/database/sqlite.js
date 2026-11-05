// Persistent state: sessions, questions, responses, notifications and an audit trail.
// Uses Node's built-in SQLite (node:sqlite) so there is no native database dependency.
import fs from 'node:fs';
import path from 'node:path';

// node:sqlite prints an ExperimentalWarning on load; silence only that one.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  return originalEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  cwd TEXT,
  command TEXT,
  process_id INTEGER,
  runner_pid INTEGER,
  claude_session_id TEXT,
  status TEXT NOT NULL,
  waiting_prompt INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  exit_signal TEXT,
  last_input_at INTEGER,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  dedupe_key TEXT UNIQUE,
  event_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  push_after INTEGER NOT NULL,
  pushed_at INTEGER,
  push_attempts INTEGER NOT NULL DEFAULT 0,
  next_push_at INTEGER,
  push_error TEXT,
  answered_at INTEGER,
  answer TEXT,
  hook_output TEXT,
  resolution_note TEXT,
  chat_synced_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  session_id TEXT,
  response_type TEXT NOT NULL,
  response_value TEXT,
  user TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  result TEXT,
  reason TEXT,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_responses_unacked ON responses(acked_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS channel_messages (
  channel TEXT NOT NULL,
  question_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chat_id TEXT,
  sent_at INTEGER NOT NULL,
  synced_status TEXT,
  PRIMARY KEY (channel, question_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_msg ON channel_messages(channel, message_id);

-- WhatsApp group per session (BRIDGE_WHATSAPP_GROUPS=on). lid_map: {"…@lid": "<phone>"} of its members.
CREATE TABLE IF NOT EXISTS whatsapp_groups (
  session_id TEXT PRIMARY KEY,
  jid TEXT NOT NULL UNIQUE,
  subject TEXT,
  lid_map TEXT,
  created_at INTEGER NOT NULL
);

-- Every copy of a question sent to a channel (one per recipient chat when it has several).
CREATE TABLE IF NOT EXISTS channel_message_copies (
  channel TEXT NOT NULL,
  question_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chat_id TEXT,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (channel, message_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_message_copies_q ON channel_message_copies(channel, question_id);

CREATE TABLE IF NOT EXISTS channel_notifications (
  channel TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (channel, notification_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  question_id TEXT,
  session_id TEXT,
  detail TEXT
);
`;

const JSON_COLS = { options: [], payload: {}, answer: null, hook_output: null, response_value: null, detail: null };

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const [col, def] of Object.entries(JSON_COLS)) {
    if (col in out) {
      try {
        out[col] = out[col] == null ? def : JSON.parse(out[col]);
      } catch {
        out[col] = def;
      }
    }
  }
  return out;
}

export class BridgeDb {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    if (file !== ':memory:') {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort (Windows) */
      }
    }
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  // ---------- sessions ----------
  createSession({ projectName, cwd, command, runnerPid, now = Date.now() }) {
    return this.tx(() => {
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sessions').get().m || 0) + 1;
      const id = `session_${String(seq).padStart(3, '0')}`;
      this.db
        .prepare(
          `INSERT INTO sessions(id, seq, project_name, cwd, command, runner_pid, status, started_at, last_activity_at, last_heartbeat_at)
           VALUES(?, ?, ?, ?, ?, ?, 'STARTING', ?, ?, ?)`,
        )
        .run(id, seq, projectName, cwd ?? null, command ?? null, runnerPid ?? null, now, now, now);
      return this.getSession(id);
    });
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
  }

  listSessions({ includeEnded = true } = {}) {
    const sql = includeEnded
      ? 'SELECT * FROM sessions ORDER BY seq'
      : "SELECT * FROM sessions WHERE status NOT IN ('COMPLETED','FAILED','STOPPED') ORDER BY seq";
    return this.db.prepare(sql).all();
  }

  updateSession(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return this.getSession(id);
    const set = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE sessions SET ${set} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    return this.getSession(id);
  }

  // ---------- questions ----------
  insertQuestion(q) {
    this.db
      .prepare(
        `INSERT INTO questions(id, session_id, dedupe_key, event_type, kind, title, question, options, payload, status,
           created_at, expires_at, push_after, next_push_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
      )
      .run(
        q.id, q.sessionId, q.dedupeKey ?? null, q.eventType, q.kind, q.title ?? null, q.question,
        JSON.stringify(q.options ?? []), JSON.stringify(q.payload ?? {}), q.createdAt, q.expiresAt, q.pushAfter, q.pushAfter,
      );
    return this.getQuestion(q.id);
  }

  getQuestion(id) {
    return hydrate(this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
  }

  getQuestionByDedupe(key) {
    return hydrate(this.db.prepare('SELECT * FROM questions WHERE dedupe_key = ?').get(key));
  }

  listQuestions({ status = null, sessionId = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status) {
      const list = Array.isArray(status) ? status : [status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (sessionId) {
      where.push('session_id = ?');
      args.push(sessionId);
    }
    const sql = `SELECT * FROM questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit).map(hydrate);
  }

  updateQuestion(id, fields) {
    const keys = Object.keys(fields);
    const vals = keys.map((k) => (k in JSON_COLS && fields[k] !== null && typeof fields[k] !== 'string' ? JSON.stringify(fields[k]) : fields[k]));
    this.db.prepare(`UPDATE questions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getQuestion(id);
  }

  /** Atomic compare-and-set on status: returns the updated row or null if the status didn't match. */
  transitionQuestion(id, fromStatuses, toStatus, fields = {}) {
    const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    const keys = Object.keys(fields);
    const vals = keys.map((k) => (k in JSON_COLS && fields[k] !== null && typeof fields[k] !== 'string' ? JSON.stringify(fields[k]) : fields[k]));
    const r = this.db
      .prepare(
        `UPDATE questions SET status = ?${keys.map((k) => `, ${k} = ?`).join('')}
         WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
      )
      .run(toStatus, ...vals, id, ...from);
    return r.changes ? this.getQuestion(id) : null;
  }

  dueForPush(now = Date.now()) {
    return this.db
      .prepare("SELECT * FROM questions WHERE status = 'PENDING' AND pushed_at IS NULL AND COALESCE(next_push_at, push_after) <= ? ORDER BY created_at")
      .all(now)
      .map(hydrate);
  }

  unsyncedStatuses() {
    return this.db
      .prepare("SELECT * FROM questions WHERE pushed_at IS NOT NULL AND status <> 'PENDING' AND (chat_synced_status IS NULL OR chat_synced_status <> status)")
      .all()
      .map(hydrate);
  }

  // ---------- responses ----------
  insertResponseIfNew(r) {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO responses(id, question_id, session_id, response_type, response_value, user, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.questionId, r.sessionId ?? null, r.type, JSON.stringify(r.value ?? null), r.user ?? null, r.createdAt ?? Date.now());
    return res.changes === 1;
  }

  getResponse(id) {
    return hydrate(this.db.prepare('SELECT * FROM responses WHERE id = ?').get(id));
  }

  updateResponse(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE responses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  }

  unackedResponses() {
    return this.db.prepare('SELECT * FROM responses WHERE processed_at IS NOT NULL AND acked_at IS NULL').all().map(hydrate);
  }

  // ---------- notifications ----------
  queueNotification({ id, kind, sessionId = null, payload, now = Date.now() }) {
    this.db
      .prepare('INSERT OR IGNORE INTO notifications(id, kind, session_id, payload, created_at, next_attempt_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, kind, sessionId, JSON.stringify(payload), now, now);
  }

  dueNotifications(now = Date.now()) {
    return this.db
      .prepare('SELECT * FROM notifications WHERE sent_at IS NULL AND next_attempt_at <= ? ORDER BY created_at LIMIT 20')
      .all(now)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  markNotification(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE notifications SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  }

  // ---------- per-channel delivery (WhatsApp, Telegram, …) ----------
  dueForChannel(channel, now = Date.now()) {
    return this.db
      .prepare(
        `SELECT q.* FROM questions q LEFT JOIN channel_messages m ON m.channel = ? AND m.question_id = q.id
         WHERE q.status = 'PENDING' AND m.question_id IS NULL AND q.push_after <= ? ORDER BY q.created_at`,
      )
      .all(channel, now)
      .map(hydrate);
  }

  recordChannelMessage({ channel, questionId, messageId, chatId, now = Date.now() }) {
    this.db
      .prepare('INSERT OR REPLACE INTO channel_messages(channel, question_id, message_id, chat_id, sent_at, synced_status) VALUES(?, ?, ?, ?, ?, ?)')
      .run(channel, questionId, messageId, chatId ?? null, now, 'PENDING');
  }

  channelMessage(channel, questionId) {
    return this.db.prepare('SELECT * FROM channel_messages WHERE channel = ? AND question_id = ?').get(channel, questionId) ?? null;
  }

  saveWhatsAppGroup({ sessionId, jid, subject, lidMap = {}, now = Date.now() }) {
    this.db
      .prepare('INSERT OR REPLACE INTO whatsapp_groups(session_id, jid, subject, lid_map, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(sessionId, jid, subject, JSON.stringify(lidMap), now);
  }

  whatsAppGroup({ sessionId, jid }) {
    const row = sessionId
      ? this.db.prepare('SELECT * FROM whatsapp_groups WHERE session_id = ?').get(sessionId)
      : this.db.prepare('SELECT * FROM whatsapp_groups WHERE jid = ?').get(jid);
    return row ? { ...row, lidMap: JSON.parse(row.lid_map || '{}') } : null;
  }

  recordChannelCopy({ channel, questionId, messageId, chatId, now = Date.now() }) {
    this.db
      .prepare('INSERT OR REPLACE INTO channel_message_copies(channel, question_id, message_id, chat_id, sent_at) VALUES(?, ?, ?, ?, ?)')
      .run(channel, questionId, messageId, chatId ?? null, now);
  }

  /** All copies of a question on a channel; falls back to the single channel_messages row. */
  channelMessageCopies(channel, questionId) {
    const copies = this.db.prepare('SELECT * FROM channel_message_copies WHERE channel = ? AND question_id = ? ORDER BY sent_at').all(channel, questionId);
    if (copies.length) return copies;
    const row = this.channelMessage(channel, questionId);
    return row ? [row] : [];
  }

  questionForChannelMessage(channel, messageId) {
    const row =
      this.db.prepare('SELECT question_id FROM channel_messages WHERE channel = ? AND message_id = ?').get(channel, messageId) ??
      this.db.prepare('SELECT question_id FROM channel_message_copies WHERE channel = ? AND message_id = ?').get(channel, messageId);
    return row ? this.getQuestion(row.question_id) : null;
  }

  /** Channel messages whose question changed state since the channel last showed it. */
  channelStatusChanges(channel) {
    return this.db
      .prepare(
        `SELECT m.*, q.status AS question_status FROM channel_messages m JOIN questions q ON q.id = m.question_id
         WHERE m.channel = ? AND q.status <> COALESCE(m.synced_status, '')`,
      )
      .all(channel);
  }

  markChannelSynced(channel, questionId, status) {
    this.db.prepare('UPDATE channel_messages SET synced_status = ? WHERE channel = ? AND question_id = ?').run(status, channel, questionId);
  }

  pendingQuestionsOnChannel(channel) {
    return this.db
      .prepare(`SELECT q.* FROM questions q JOIN channel_messages m ON m.channel = ? AND m.question_id = q.id WHERE q.status = 'PENDING' ORDER BY q.created_at`)
      .all(channel)
      .map(hydrate);
  }

  notificationsForChannel(channel, since) {
    return this.db
      .prepare(
        `SELECT n.* FROM notifications n LEFT JOIN channel_notifications c ON c.channel = ? AND c.notification_id = n.id
         WHERE c.notification_id IS NULL AND n.created_at >= ? ORDER BY n.created_at LIMIT 20`,
      )
      .all(channel, since)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  markChannelNotification(channel, id, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO channel_notifications(channel, notification_id, sent_at) VALUES(?, ?, ?)').run(channel, id, now);
  }

  // ---------- audit ----------
  audit({ actor = 'bridge', action, questionId = null, sessionId = null, detail = null, now = Date.now() }) {
    this.db
      .prepare('INSERT INTO audit_log(ts, actor, action, question_id, session_id, detail) VALUES(?, ?, ?, ?, ?, ?)')
      .run(now, actor, action, questionId, sessionId, detail == null ? null : JSON.stringify(detail));
  }

  auditTail(limit = 50) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit).map(hydrate);
  }
}
