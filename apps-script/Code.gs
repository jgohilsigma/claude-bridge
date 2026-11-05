/**
 * Claude Assistant — Google Chat app + relay for claude-chat-bridge.
 *
 * One Apps Script project plays two roles (both free):
 *  1. Google Chat app "Claude Assistant": shows question cards, handles buttons, dialogs and
 *     commands (/sessions /status /pending /help /cancel /reply).
 *  2. Web app relay: the bridge on your PC calls doPost() over HTTPS (outbound only) to publish
 *     questions and to long-poll your answers. Every request/response is an HMAC-signed envelope.
 *
 * Script Properties (Project Settings → Script properties):
 *   SHARED_SECRET          required  same value as BRIDGE_SHARED_SECRET on the PC (>= 32 chars)
 *   ALLOWED_EMAILS         required  comma-separated Workspace emails allowed to answer
 *   ALLOWED_USER_IDS       optional  comma-separated Chat user ids ("users/123...") also allowed
 *   SERVICE_ACCOUNT_JSON   optional  key JSON of a service account → push interactive cards (app auth, chat.bot scope)
 *   WEBHOOK_URL            optional  incoming webhook of a Chat space → push text notifications (fallback)
 *   PUSH_MODE              optional  gmail | app | webhook | none
 *                                    (default: app if SERVICE_ACCOUNT_JSON, webhook if WEBHOOK_URL, otherwise gmail)
 *   NOTIFY_EMAIL           gmail     where question emails go (default: the script owner's address)
 *   SIGNATURE_MARKER       gmail     optional: first words of your email signature, cut from replies
 *   ANSWER_URL             gmail     /exec URL of a 2nd web-app deployment with access "Anyone within <your domain>";
 *                                    enables one-tap answer links in emails (identity-checked). Without it: reply by email.
 *   CHAT_SPACE             auto      captured from your DM with the app (spaces/XXXX)
 *   SPREADSHEET_ID         auto      history spreadsheet created by setup()
 *   OFFLINE_AFTER_MIN      optional  minutes without a poll before "bridge offline" is announced (default 5)
 *   REMIND_AFTER_MIN       optional  minutes before an unanswered-question reminder (default 15)
 *
 * When the bridge switches to other channels only (e.g. BRIDGE_CHANNELS=whatsapp) it calls setActive
 * with active=false: this relay then sends nothing (no emails, reminders or "bridge offline" notices)
 * until the bridge polls again.
 */

var VERSION = '1.6.0';
var CMD = { SESSIONS: 1, STATUS: 2, PENDING: 3, HELP: 4, CANCEL: 5, REPLY: 6 };
var TERMINAL = ['DELIVERED', 'FAILED', 'ANSWERED_LOCALLY', 'EXPIRED', 'CANCELLED'];
var MAX_SKEW_MS = 5 * 60 * 1000;
var ACTION_FN = 'onCardAction';

// =====================================================================================
// Configuration & storage
// =====================================================================================

function props_() {
  return PropertiesService.getScriptProperties();
}

function cfg_() {
  var p = props_().getProperties();
  var list = function (s) {
    return String(s || '')
      .toLowerCase()
      .split(/[,\s]+/)
      .filter(function (x) { return !!x; });
  };
  var mode = String(p.PUSH_MODE || (p.SERVICE_ACCOUNT_JSON ? 'app' : p.WEBHOOK_URL ? 'webhook' : 'gmail')).toLowerCase();
  return {
    secret: p.SHARED_SECRET || '',
    allowed: list(p.ALLOWED_EMAILS),
    allowedIds: list(p.ALLOWED_USER_IDS),
    pushMode: mode,
    serviceAccount: p.SERVICE_ACCOUNT_JSON || '',
    webhook: p.WEBHOOK_URL || '',
    space: p.CHAT_SPACE || '',
    spreadsheetId: p.SPREADSHEET_ID || '',
    notifyEmail: p.NOTIFY_EMAIL || '',
    answerUrl: p.ANSWER_URL || '',
    offlineAfterMin: num_(p.OFFLINE_AFTER_MIN, 5),
    remindAfterMin: num_(p.REMIND_AFTER_MIN, 15),
  };
}

function num_(v, def) {
  var n = Number(v);
  return v === undefined || v === null || v === '' || isNaN(n) ? def : n;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Question records: { q, status, answeredBy, answerSummary, note, messageName, pushAttempts, reminded, updatedAt } */
function getRec_(id) {
  if (!/^q[a-z0-9]{4,10}$/.test(String(id || ''))) return null;
  var raw = props_().getProperty('Q_' + id);
  return raw ? JSON.parse(raw) : null;
}

function saveRec_(rec) {
  rec.updatedAt = Date.now();
  var json = JSON.stringify(rec);
  // Script Properties values are limited to ~9 KB: progressively shorten long fields.
  var guard = 0;
  while (json.length > 8000 && guard++ < 6) {
    var q = rec.q;
    q.text = String(q.text || '').slice(0, Math.floor(String(q.text || '').length * 0.6)) + '…';
    if (q.permission) q.permission.detail = String(q.permission.detail || '').slice(0, 300);
    if (q.context) {
      q.context.lastMessage = String(q.context.lastMessage || '').slice(0, 300);
      q.context.task = String(q.context.task || '').slice(0, 300);
      q.context.actions = (q.context.actions || []).slice(-6);
    }
    (q.options || []).forEach(function (o) { o.description = String(o.description || '').slice(0, 60); });
    (q.questions || []).forEach(function (x) { (x.options || []).forEach(function (o) { o.description = String(o.description || '').slice(0, 40); }); });
    json = JSON.stringify(rec);
  }
  props_().setProperty('Q_' + rec.q.id, json);
  return rec;
}

function allRecs_() {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('Q_') === 0) {
      try { out.push(JSON.parse(all[k])); } catch (e) { /* ignore corrupt */ }
    }
  });
  out.sort(function (a, b) { return a.q.createdAt - b.q.createdAt; });
  return out;
}

function pendingResponses_() {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('R_') === 0) {
      try { out.push(JSON.parse(all[k])); } catch (e) { /* ignore */ }
    }
  });
  out.sort(function (a, b) { return a.createdAt - b.createdAt; });
  return out;
}

function getJsonProp_(key, def) {
  var raw = props_().getProperty(key);
  if (!raw) return def;
  try { return JSON.parse(raw); } catch (e) { return def; }
}

function setJsonProp_(key, value) {
  props_().setProperty(key, JSON.stringify(value));
}

// ---- history spreadsheet (best effort; never blocks the main flow) ----

function sheet_(name, header) {
  var id = cfg_().spreadsheetId;
  if (!id) return null;
  try {
    var ss = SpreadsheetApp.openById(id);
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(header);
    }
    return sh;
  } catch (e) {
    console.warn('history sheet unavailable: ' + e);
    return null;
  }
}

var HEADERS = {
  Questions: ['id', 'createdAt', 'sessionId', 'project', 'kind', 'title', 'question', 'status', 'answeredBy', 'answer', 'note', 'updatedAt'],
  Responses: ['id', 'createdAt', 'questionId', 'sessionId', 'type', 'value', 'user', 'result', 'reason'],
  Audit: ['ts', 'user', 'action', 'detail'],
};

function histAppend_(name, row) {
  var sh = sheet_(name, HEADERS[name]);
  if (sh) sh.appendRow(row);
}

function histUpdate_(name, id, colValues) {
  var sh = sheet_(name, HEADERS[name]);
  if (!sh) return;
  var cell = sh.getRange('A:A').createTextFinder(id).matchEntireCell(true).findNext();
  if (!cell) return;
  var row = cell.getRow();
  Object.keys(colValues).forEach(function (col) {
    var idx = HEADERS[name].indexOf(col);
    if (idx >= 0) sh.getRange(row, idx + 1).setValue(colValues[col]);
  });
}

function audit_(action, user, detail) {
  try {
    histAppend_('Audit', [new Date(), user || '', action, detail ? JSON.stringify(detail).slice(0, 2000) : '']);
  } catch (e) {
    console.warn('audit failed: ' + e);
  }
}

// =====================================================================================
// HMAC envelopes (same scheme as src/security/authentication.js)
// =====================================================================================

function hmacHex_(secret, text) {
  var bytes = Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verify_(secret, env) {
  if (!env || typeof env.ts !== 'number' || typeof env.nonce !== 'string' || typeof env.op !== 'string' || typeof env.payload !== 'string' || typeof env.sig !== 'string') {
    return { ok: false, error: 'malformed envelope' };
  }
  if (Math.abs(Date.now() - env.ts) > MAX_SKEW_MS) return { ok: false, error: 'stale or future timestamp' };
  if (!safeEqual_(hmacHex_(secret, env.ts + '.' + env.nonce + '.' + env.op + '.' + env.payload), env.sig)) return { ok: false, error: 'bad signature' };
  var cache = CacheService.getScriptCache();
  var key = 'n_' + env.nonce.slice(0, 200);
  if (cache.get(key)) return { ok: false, error: 'replayed nonce' };
  cache.put(key, '1', 900);
  try {
    return { ok: true, op: env.op, payload: JSON.parse(env.payload) };
  } catch (e) {
    return { ok: false, error: 'payload is not JSON' };
  }
}

function sign_(secret, op, payloadObj) {
  var payload = JSON.stringify(payloadObj || {});
  var ts = Date.now();
  var nonce = Utilities.getUuid();
  return { v: 1, ts: ts, nonce: nonce, op: op, payload: payload, sig: hmacHex_(secret, ts + '.' + nonce + '.' + op + '.' + payload) };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================================
// Web app relay (called by the bridge on your PC)
// =====================================================================================

function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'answer') return answerPage_(e.parameter);
  return jsonOut_({ ok: true, app: 'claude-chat-bridge relay', version: VERSION, note: 'POST signed envelopes only' });
}

function doPost(e) {
  var c = cfg_();
  if (!c.secret || c.secret.length < 32) return jsonOut_({ error: 'SHARED_SECRET (>= 32 chars) is not set in Script Properties' });
  var env;
  try {
    env = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return jsonOut_({ error: 'invalid JSON' });
  }
  var v = verify_(c.secret, env);
  if (!v.ok) {
    audit_('relay.auth_rejected', '', { error: v.error });
    return jsonOut_({ error: v.error });
  }
  var result;
  try {
    result = handleOp_(v.op, v.payload || {}, c);
  } catch (err) {
    console.error('op ' + v.op + ' failed: ' + (err && err.stack));
    result = { error: String((err && err.message) || err), retryable: true };
  }
  return jsonOut_(sign_(c.secret, 'resp:' + v.op, result));
}

function handleOp_(op, p, c) {
  switch (op) {
    case 'ping':
      return opPing_(p, c);
    case 'upsertQuestions':
      return opUpsertQuestions_(p, c);
    case 'updateQuestions':
      return opUpdateQuestions_(p, c);
    case 'notify':
      return opNotify_(p, c);
    case 'syncSessions':
      setJsonProp_('SESSIONS', { at: Date.now(), sessions: (p.sessions || []).slice(0, 50) });
      markBridgeSeen_(c, p.bridge);
      return { ok: true };
    case 'poll':
      return opPoll_(p, c);
    case 'ack':
      return opAck_(p, c);
    case 'setActive':
      return opSetActive_(p, c);
    default:
      return { error: 'unknown op ' + op, retryable: false };
  }
}

/** Paused = the bridge uses other channels (WhatsApp…): send nothing until it polls again. */
function opSetActive_(p, c) {
  var b = getJsonProp_('BRIDGE', {});
  b.paused = !p.active;
  b.channels = (p.channels || []).slice(0, 10);
  b.offlineNotified = false;
  if (p.active) b.lastSeenAt = Date.now();
  setJsonProp_('BRIDGE', b);
  audit_(p.active ? 'relay.resumed' : 'relay.paused', '', { channels: b.channels });
  return { ok: true, paused: b.paused, version: VERSION };
}

function relayPaused_() {
  return !!getJsonProp_('BRIDGE', {}).paused;
}

function markBridgeSeen_(c, info) {
  var b = getJsonProp_('BRIDGE', {});
  var wasOffline = !!b.offlineNotified;
  b.paused = false;
  b.lastSeenAt = Date.now();
  if (info) {
    b.version = info.version;
    b.host = info.host;
  }
  b.offlineNotified = false;
  setJsonProp_('BRIDGE', b);
  if (wasOffline) push_(c, { text: '✅ *Bridge reconnected*' + (b.host ? ' (' + b.host + ')' : '') + '. Pending answers are being delivered.' }, null);
}

function opPing_(p, c) {
  var out = {
    version: VERSION,
    allowlistCount: c.allowed.length + c.allowedIds.length,
    pushMode: c.pushMode,
    space: c.space,
    webhook: !!c.webhook,
    notifyEmail: c.pushMode === 'gmail' ? notifyAddress_(c) : '',
    triggers: (function () { try { return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }); } catch (e) { return null; } })(),
    mailQuota: (function () { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return null; } })(),
    answerUrl: c.answerUrl,
    spreadsheet: '',
    problems: [],
  };
  if (c.spreadsheetId) {
    try {
      out.spreadsheet = SpreadsheetApp.openById(c.spreadsheetId).getName();
    } catch (e) {
      out.problems.push('SPREADSHEET_ID is set but cannot be opened: ' + e);
    }
  }
  if (c.pushMode === 'app') {
    try {
      appToken_(true);
      out.appAuth = { ok: true };
    } catch (e) {
      out.appAuth = { ok: false, error: String(e.message || e) };
    }
  }
  markBridgeSeen_(c, null);
  if (p.sendTest) {
    var r = push_(c, { text: '🔔 *Claude Assistant test message* — the bridge on your PC can reach Google Chat.' }, null);
    out.test = r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  return out;
}

function sanitizeQ_(q) {
  if (!q || !/^q[a-z0-9]{4,10}$/.test(String(q.id))) throw new Error('invalid question id');
  if (!/^session_\d{3,}$/.test(String(q.sessionId))) throw new Error('invalid session id');
  var kinds = ['ask_user_question', 'permission', 'free_text', 'menu', 'yes_no', 'text_prompt'];
  if (kinds.indexOf(q.kind) < 0) throw new Error('invalid kind');
  return {
    id: q.id,
    sessionId: q.sessionId,
    project: String(q.project || '').slice(0, 80),
    cwd: String(q.cwd || '').slice(0, 200),
    kind: q.kind,
    title: String(q.title || '').slice(0, 120),
    text: String(q.text || '').slice(0, 3000),
    options: (q.options || []).slice(0, 12).map(function (o) { return { label: String(o.label || '').slice(0, 120), description: String(o.description || '').slice(0, 200) }; }),
    questions: (q.questions || []).slice(0, 4),
    permission: q.permission || null,
    allowText: !!q.allowText,
    context: q.context
      ? {
          task: String(q.context.task || '').slice(0, 600),
          actions: (q.context.actions || []).slice(0, 12).map(function (a) { return String(a).slice(0, 120); }),
          lastMessage: String(q.context.lastMessage || '').slice(0, 1200),
        }
      : null,
    createdAt: Number(q.createdAt) || Date.now(),
    expiresAt: Number(q.expiresAt) || Date.now() + 1800000,
  };
}

function opUpsertQuestions_(p, c) {
  var results = [];
  (p.questions || []).forEach(function (raw) {
    try {
      var q = sanitizeQ_(raw);
      var rec = withLock_(function () {
        var existing = getRec_(q.id);
        if (existing) return existing; // idempotent retry
        var r = saveRec_({ q: q, status: 'PENDING', answeredBy: '', answerSummary: '', note: '', messageName: '', pushAttempts: 0, reminded: false });
        histAppend_('Questions', [q.id, new Date(q.createdAt), q.sessionId, q.project, q.kind, q.title, q.text.slice(0, 1000), 'PENDING', '', '', '', new Date()]);
        return r;
      });
      var warning = '';
      if (!rec.messageName && rec.pushAttempts < 5) {
        var pushed = pushQuestion_(c, rec);
        if (!pushed.ok) warning = pushed.error;
      }
      results.push({ id: q.id, ok: true, warning: warning });
    } catch (e) {
      results.push({ id: raw && raw.id, ok: false, error: String(e.message || e) });
    }
  });
  return { results: results };
}

function opUpdateQuestions_(p, c) {
  var updated = 0;
  (p.updates || []).forEach(function (u) {
    var rec = withLock_(function () {
      var r = getRec_(u.id);
      if (!r) return null;
      r.status = String(u.status || r.status);
      if (u.note) r.note = String(u.note).slice(0, 300);
      if (u.answerSummary) r.answerSummary = String(u.answerSummary).slice(0, 300);
      if (u.answeredBy) r.answeredBy = String(u.answeredBy).slice(0, 120);
      return saveRec_(r);
    });
    if (!rec) return;
    updated++;
    histUpdate_('Questions', rec.q.id, { status: rec.status, answeredBy: rec.answeredBy, answer: rec.answerSummary, note: rec.note, updatedAt: new Date() });
    refreshPushedCard_(c, rec);
  });
  return { ok: true, updated: updated };
}

function opNotify_(p, c) {
  var cache = CacheService.getScriptCache();
  var sent = 0;
  (p.events || []).forEach(function (n) {
    var key = 'notif_' + String(n.id).slice(0, 100);
    if (cache.get(key)) return; // duplicate delivery after a retry
    var where = n.project ? ' — ' + n.project + (n.sessionId ? ' (' + n.sessionId + ')' : '') : '';
    if (c.pushMode === 'gmail' && n.project) {
      var r0 = sendMail_(c, '[Claude · ' + n.project + '] ' + (n.title || 'Notification') + (n.sessionId ? ' (' + n.sessionId + ')' : ''),
        '📂 ' + n.project + (n.sessionId ? ' · ' + n.sessionId : '') + '\n\n' + (n.text || ''), null);
      if (r0.ok) { cache.put(key, '1', 21600); sent++; }
      audit_('notify.' + (n.kind || 'event'), '', { id: n.id, ok: r0.ok, error: r0.error || '' });
      return;
    }
    var r = push_(c, { text: '*' + (n.title || 'Notification') + '*' + where + '\n' + (n.text || '') }, 'n' + String(n.id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50));
    if (r.ok) {
      cache.put(key, '1', 21600);
      sent++;
    }
    audit_('notify.' + (n.kind || 'event'), '', { id: n.id, ok: r.ok, error: r.error || '' });
  });
  return { ok: true, sent: sent };
}

function opPoll_(p, c) {
  markBridgeSeen_(c, null);
  var cache = CacheService.getScriptCache();
  var deadline = Date.now() + Math.min(25, Math.max(0, Number(p.wait) || 0)) * 1000;
  var list = pendingResponses_();
  while (!list.length && Date.now() < deadline) {
    Utilities.sleep(1000);
    if (cache.get('resp_dirty')) {
      cache.remove('resp_dirty');
      list = pendingResponses_();
    }
  }
  return { responses: list };
}

function opAck_(p, c) {
  (p.acks || []).forEach(function (a) {
    var resp = getJsonProp_('R_' + a.id, null);
    props_().deleteProperty('R_' + a.id);
    histUpdate_('Responses', String(a.id), { result: a.result, reason: a.reason || '' });
    var rec = withLock_(function () {
      var r = getRec_(a.questionId || (resp && resp.questionId));
      if (!r) return null;
      if (a.result === 'accepted') {
        r.status = a.questionStatus || 'DELIVERED';
        r.note = '';
      } else {
        // Rejected by the bridge: the question may still be open (e.g. invalid answer) or resolved.
        r.status = a.questionStatus || 'PENDING';
        r.note = 'Not delivered: ' + String(a.reason || 'rejected').slice(0, 250);
        if (r.status === 'PENDING') {
          r.answeredBy = '';
          r.answerSummary = '';
        }
      }
      return saveRec_(r);
    });
    if (rec) refreshPushedCard_(c, rec);
  });
  return { ok: true };
}

// =====================================================================================
// Pushing messages into Google Chat
// =====================================================================================

/** Sends a message proactively. Returns { ok, name?, error? }. */
function push_(c, message, clientId) {
  if (relayPaused_()) return { ok: false, error: 'relay paused: the bridge currently uses other channels' };
  try {
    if (c.pushMode === 'app') {
      if (!c.space) return { ok: false, error: 'CHAT_SPACE unknown: open a DM with Claude Assistant and send "help" first' };
      var url = 'https://chat.googleapis.com/v1/' + c.space + '/messages' + (clientId ? '?messageId=client-' + clientId : '');
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + appToken_(false) },
        payload: JSON.stringify(message),
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      if (code === 200) return { ok: true, name: JSON.parse(res.getContentText()).name };
      if (code === 409 && clientId) return { ok: true, name: c.space + '/messages/client-' + clientId };
      return { ok: false, error: 'Chat API HTTP ' + code + ': ' + res.getContentText().slice(0, 300) };
    }
    if (c.pushMode === 'gmail') {
      var subject = message.subject || String(message.text || 'Claude Assistant').split('\n')[0].replace(/[*`]/g, '').slice(0, 120);
      return sendMail_(c, subject, message.text || '', message.html || null);
    }
    if (c.pushMode === 'webhook') {
      if (!c.webhook) return { ok: false, error: 'WEBHOOK_URL not set' };
      var text = message.fallbackText || message.text || '';
      var wr = UrlFetchApp.fetch(c.webhook, { method: 'post', contentType: 'application/json; charset=UTF-8', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
      return wr.getResponseCode() === 200 ? { ok: true, name: '' } : { ok: false, error: 'webhook HTTP ' + wr.getResponseCode() + ': ' + wr.getContentText().slice(0, 200) };
    }
    return { ok: false, error: 'PUSH_MODE is none: use /pending in Chat' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function pushQuestion_(c, rec) {
  if (c.pushMode === 'gmail') return pushQuestionEmail_(c, rec);
  var msg = questionMessage_(rec);
  msg.fallbackText = webhookText_(rec);
  var r = push_(c, c.pushMode === 'webhook' ? msg : { text: msg.text, cardsV2: msg.cardsV2 }, rec.q.id);
  withLock_(function () {
    var cur = getRec_(rec.q.id) || rec;
    cur.pushAttempts = (cur.pushAttempts || 0) + 1;
    if (r.ok) cur.messageName = r.name || 'webhook';
    saveRec_(cur);
  });
  if (!r.ok) console.warn('push failed for ' + rec.q.id + ': ' + r.error);
  return r;
}

/** Updates a question card that was pushed with app auth (webhook messages can't be edited). */
function refreshPushedCard_(c, rec) {
  if (c.pushMode === 'gmail') return refreshEmail_(c, rec);
  if (c.pushMode !== 'app' || !rec.messageName || rec.messageName === 'webhook') return;
  try {
    var msg = questionMessage_(rec);
    UrlFetchApp.fetch('https://chat.googleapis.com/v1/' + rec.messageName + '?updateMask=text,cardsV2', {
      method: 'patch',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + appToken_(false) },
      payload: JSON.stringify({ text: msg.text, cardsV2: msg.cardsV2 }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.warn('card refresh failed: ' + e);
  }
}

/** OAuth access token for the Chat app's service account (app authentication, chat.bot scope). */
function appToken_(forceFresh) {
  var cache = CacheService.getScriptCache();
  if (!forceFresh) {
    var cached = cache.get('sa_token');
    if (cached) return cached;
  }
  var raw = cfg_().serviceAccount;
  if (!raw) throw new Error('SERVICE_ACCOUNT_JSON is not set');
  var sa = JSON.parse(raw);
  var now = Math.floor(Date.now() / 1000);
  var b64 = function (s) { return Utilities.base64EncodeWebSafe(s).replace(/=+$/, ''); };
  var header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claims = b64(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/chat.bot', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  var signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(header + '.' + claims, sa.private_key)).replace(/=+$/, '');
  var res = UrlFetchApp.fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claims + '.' + signature },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('service account token request failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  var token = JSON.parse(res.getContentText()).access_token;
  cache.put('sa_token', token, 3300);
  return token;
}

// =====================================================================================
// Cards
// =====================================================================================

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function multiline_(s) {
  return esc_(s).replace(/\n/g, '<br>');
}

function btn_(text, params, opts) {
  opts = opts || {};
  var action = { function: ACTION_FN, parameters: Object.keys(params).map(function (k) { return { key: k, value: String(params[k]) }; }) };
  if (opts.dialog) action.interaction = 'OPEN_DIALOG';
  var b = { text: text, onClick: { action: action } };
  if (opts.filled) b.type = 'FILLED';
  return b;
}

function fmtTime_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'HH:mm');
}

var STATUS_TEXT = {
  PENDING: '⏳ Waiting for your answer',
  ANSWERED: '📨 Answer recorded — delivering to your PC…',
  DELIVERED: '✅ Delivered',
  FAILED: '❌ Not delivered',
  ANSWERED_LOCALLY: '💻 Answered in the terminal',
  EXPIRED: '⌛ Expired — the terminal prompt is shown instead',
  CANCELLED: '🚫 Dismissed',
};

function optionLabel_(i, label) {
  var t = (i + 1) + '. ' + String(label || '');
  return t.length > 48 ? t.slice(0, 47) + '…' : t;
}

function questionCard_(rec, opts) {
  opts = opts || {};
  var q = rec.q;
  var ids = { q: q.id, s: q.sessionId };
  var withIds = function (extra) {
    var o = { q: q.id, s: q.sessionId };
    Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  };
  var widgets = [];
  var p = q.permission;
  if (q.context && q.context.task) widgets.push({ decoratedText: { topLabel: 'You asked', text: esc_(String(q.context.task).slice(0, 300)), wrapText: true } });
  if (q.context && q.context.actions && q.context.actions.length) widgets.push({ decoratedText: { topLabel: 'What Claude did', text: esc_(q.context.actions.slice(-5).join(' · ')), wrapText: true } });
  if (q.kind === 'permission' && p) {
    widgets.push({ decoratedText: { topLabel: p.tool, text: '<b>' + multiline_(p.summary) + '</b>', wrapText: true } });
    if (p.detail) widgets.push({ textParagraph: { text: multiline_(p.detail) } });
    if (p.dangerous) widgets.push({ textParagraph: { text: '<font color="#d93025"><b>⚠️ Sensitive operation:</b> ' + esc_((p.reasons || []).join(', ')) + '</font>' } });
  } else {
    widgets.push({ textParagraph: { text: multiline_(q.text) } });
  }
  if (q.kind === 'ask_user_question' && q.questions && (q.questions.length > 1 || (q.questions[0] && q.questions[0].multiSelect))) {
    q.questions.forEach(function (x, i) {
      widgets.push({ textParagraph: { text: '<b>' + (i + 1) + ') ' + esc_(x.question) + '</b>' + (x.multiSelect ? ' <i>(choose any)</i>' : '') + '<br>' + (x.options || []).map(function (o) { return '• ' + esc_(o.label) + (o.description ? ' — <i>' + esc_(o.description) + '</i>' : ''); }).join('<br>') } });
    });
  } else if ((q.options || []).some(function (o) { return o.description; })) {
    widgets.push({ textParagraph: { text: q.options.map(function (o, i) { return '<b>' + (i + 1) + '.</b> ' + esc_(o.label) + (o.description ? ' — <i>' + esc_(o.description) + '</i>' : ''); }).join('<br>') } });
  }

  var statusLine = STATUS_TEXT[rec.status] || rec.status;
  if (rec.answerSummary) statusLine += ': <b>' + esc_(rec.answerSummary) + '</b>';
  if (rec.answeredBy) statusLine += ' <i>(' + esc_(rec.answeredBy) + ')</i>';
  if (rec.note) statusLine += '<br><i>' + esc_(rec.note) + '</i>';
  if (rec.status === 'PENDING') statusLine += '<br><i>Expires at ' + fmtTime_(q.expiresAt) + '</i>';
  if (rec.lastError) statusLine = '<font color="#d93025">⚠️ ' + esc_(rec.lastError) + '</font><br>' + statusLine;
  if (opts.bridgeOffline && (rec.status === 'PENDING' || rec.status === 'ANSWERED')) statusLine += '<br><font color="#b06000">The bridge PC is offline; answers are delivered when it reconnects.</font>';

  var sections = [{ widgets: widgets }];
  var buttons = [];
  if (rec.status === 'PENDING') {
    if (opts.confirmDanger) {
      sections.push({ widgets: [{ textParagraph: { text: '<font color="#d93025"><b>Confirm:</b> allow this sensitive operation on your PC?</font>' } }] });
      buttons.push(btn_('⚠️ Yes, allow', withIds({ act: 'allow', c: '1' }), { filled: true }));
      buttons.push(btn_('❌ Deny', withIds({ act: 'deny' })));
      buttons.push(btn_('Back', withIds({ act: 'show' })));
    } else if (q.kind === 'permission') {
      buttons.push(btn_('✅ Allow', withIds({ act: p && p.dangerous ? 'allowConfirm' : 'allow' }), { filled: true }));
      if (p && p.allowSession && !p.dangerous) buttons.push(btn_('✅ Allow for session', withIds({ act: 'allowSession' })));
      buttons.push(btn_('❌ Deny', withIds({ act: 'deny' })));
      buttons.push(btn_('💬 Deny with reason', withIds({ act: 'denyReason' }), { dialog: true }));
    } else if (q.kind === 'ask_user_question' && q.questions && (q.questions.length > 1 || (q.questions[0] && q.questions[0].multiSelect))) {
      buttons.push(btn_('📝 Answer', withIds({ act: 'form' }), { dialog: true, filled: true }));
      buttons.push(btn_('Dismiss', withIds({ act: 'cancel' })));
    } else {
      (q.options || []).forEach(function (o, i) { buttons.push(btn_(optionLabel_(i, o.label), withIds({ act: 'opt', i: i }))); });
      if (q.allowText) buttons.push(btn_(q.kind === 'free_text' ? '✏️ Reply' : '✏️ Type something', withIds({ act: 'text' }), { dialog: true }));
      buttons.push(btn_(q.kind === 'menu' || q.kind === 'yes_no' || q.kind === 'text_prompt' ? 'Leave for terminal' : 'Dismiss', withIds({ act: 'cancel' })));
    }
  }
  var statusWidgets = [{ textParagraph: { text: statusLine } }];
  if (buttons.length) statusWidgets.push({ buttonList: { buttons: buttons } });
  statusWidgets.push({ textParagraph: { text: '<font color="#80868b">Reply by text: /reply ' + q.id + ' &lt;' + (q.kind === 'permission' ? 'allow|session|deny' : 'number or text') + '&gt;</font>' } });
  sections.push({ widgets: statusWidgets });

  return {
    cardId: 'q_' + q.id,
    card: {
      header: { title: q.title || 'Claude needs your input', subtitle: (q.project ? q.project + ' · ' : '') + q.sessionId + ' · ' + q.id },
      sections: sections,
    },
  };
}

function questionMessage_(rec, opts) {
  // The short text is what phone notifications show; the card carries the details and buttons.
  var q = rec.q;
  return { text: '🔔 *' + (q.title || 'Claude needs your input') + '* — ' + (q.project || q.sessionId) + ' (`' + q.id + '`)', cardsV2: [questionCard_(rec, opts)] };
}

function webhookText_(rec) {
  var q = rec.q;
  var lines = ['*' + (q.title || 'Claude needs your input') + '*', 'Project: ' + (q.project || '-') + ' · ' + q.sessionId + ' · `' + q.id + '`', ''];
  if (q.kind === 'permission' && q.permission) {
    lines.push(q.permission.tool + ': ```' + q.permission.summary + '```');
    if (q.permission.dangerous) lines.push('⚠️ Sensitive: ' + (q.permission.reasons || []).join(', '));
    lines.push('', 'Reply in your DM with Claude Assistant: `/reply ' + q.id + ' allow` · `/reply ' + q.id + ' deny`' + (q.permission.allowSession ? ' · `/reply ' + q.id + ' session`' : ''));
  } else {
    lines.push(q.text);
    (q.options || []).forEach(function (o, i) { lines.push((i + 1) + '. ' + o.label); });
    lines.push('', 'Answer with `/pending` (buttons) or `/reply ' + q.id + ' <number or text>` in your DM with Claude Assistant.');
  }
  return lines.join('\n');
}

function textDialog_(rec, act, label) {
  var q = rec.q;
  return {
    header: { title: q.title || 'Reply', subtitle: q.project + ' · ' + q.sessionId + ' · ' + q.id },
    sections: [{
      widgets: [
        { textParagraph: { text: multiline_(String(q.text).slice(0, 1500)) } },
        { textInput: { name: 'answer', label: label, type: 'MULTIPLE_LINE' } },
        { buttonList: { buttons: [btn_('Send', { act: act, q: q.id, s: q.sessionId }, { filled: true })] } },
      ],
    }],
  };
}

function formDialog_(rec) {
  var q = rec.q;
  var widgets = [];
  (q.questions || []).forEach(function (x, i) {
    widgets.push({
      selectionInput: {
        name: 'q' + i,
        label: (x.header ? x.header + ': ' : '') + x.question,
        type: x.multiSelect ? 'CHECK_BOX' : 'RADIO_BUTTON',
        items: (x.options || []).map(function (o) { return { text: o.label, value: o.label, selected: false }; }),
      },
    });
    widgets.push({ textInput: { name: 'q' + i + '_other', label: 'Or type your own answer' } });
  });
  widgets.push({ buttonList: { buttons: [btn_('Submit', { act: 'submitForm', q: q.id, s: q.sessionId }, { filled: true })] } });
  return { header: { title: 'Claude needs your input', subtitle: q.project + ' · ' + q.sessionId + ' · ' + q.id }, sections: [{ widgets: widgets }] };
}

// =====================================================================================
// Google Chat event handling (add-on events, with fallback for legacy Chat app events)
// =====================================================================================

function norm_(e) {
  e = e || {};
  if (e.chat) {
    var c = e.chat;
    var ce = e.commonEventObject || {};
    var payload = c.messagePayload || c.buttonClickedPayload || c.appCommandPayload || c.addedToSpacePayload || c.removedFromSpacePayload || {};
    var msg = payload.message || {};
    var space = payload.space || msg.space || {};
    var cmdId = c.appCommandPayload && c.appCommandPayload.appCommandMetadata ? Number(c.appCommandPayload.appCommandMetadata.appCommandId) : msg.slashCommand ? Number(msg.slashCommand.commandId) : 0;
    return {
      addon: true,
      user: c.user || {},
      space: space.name || '',
      spaceType: space.spaceType || space.type || '',
      params: ce.parameters || {},
      form: ce.formInputs || {},
      text: String(msg.argumentText || msg.text || '').trim(),
      commandId: cmdId,
    };
  }
  var common = e.common || {};
  var m = e.message || {};
  var params = {};
  Object.keys(common.parameters || {}).forEach(function (k) { params[k] = common.parameters[k]; });
  ((e.action && e.action.parameters) || []).forEach(function (x) { params[x.key] = x.value; });
  return {
    addon: false,
    user: e.user || {},
    space: (e.space && e.space.name) || '',
    spaceType: (e.space && (e.space.spaceType || e.space.type)) || '',
    params: params,
    form: common.formInputs || {},
    text: String(m.argumentText || m.text || '').trim(),
    commandId: m.slashCommand ? Number(m.slashCommand.commandId) : e.appCommandMetadata ? Number(e.appCommandMetadata.appCommandId) : 0,
  };
}

function userEmail_(ev) {
  var email = String(ev.user.email || '').toLowerCase();
  // Add-on Chat apps run as the interacting user, so the active user is that person.
  if (!email && ev.addon) {
    try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { /* no scope */ }
  }
  return email;
}

function authorized_(ev, c) {
  var email = userEmail_(ev);
  var id = String(ev.user.name || '').toLowerCase();
  return (email && c.allowed.indexOf(email) >= 0) || (id && c.allowedIds.indexOf(id) >= 0);
}

function out_(ev) {
  return {
    message: function (m) { return ev.addon ? { hostAppDataAction: { chatDataAction: { createMessageAction: { message: m } } } } : m; },
    update: function (m) {
      if (ev.addon) return { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: m } } } };
      var r = { actionResponse: { type: 'UPDATE_MESSAGE' } };
      Object.keys(m).forEach(function (k) { r[k] = m[k]; });
      return r;
    },
    dialog: function (card) { return ev.addon ? { action: { navigations: [{ pushCard: card }] } } : { actionResponse: { type: 'DIALOG', dialogAction: { dialog: { body: card } } } }; },
    closeDialog: function (text, updated) {
      if (ev.addon) {
        if (updated) return { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: updated } } } };
        return { action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }], notification: { text: text } } };
      }
      return { actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'OK', userFacingMessage: text } } } };
    },
  };
}

function captureSpace_(ev, c) {
  if (!ev.space) return;
  var dm = /DIRECT_MESSAGE|^DM$/.test(ev.spaceType);
  if (!c.space || (dm && c.space !== ev.space && !/DIRECT_MESSAGE|^DM$/.test(String(props_().getProperty('CHAT_SPACE_TYPE') || '')))) {
    props_().setProperties({ CHAT_SPACE: ev.space, CHAT_SPACE_TYPE: ev.spaceType || '' });
    c.space = ev.space;
  }
}

function denied_(ev) {
  audit_('chat.unauthorized', userEmail_(ev) || String(ev.user.name || ''), { text: ev.text.slice(0, 200), params: ev.params });
  return out_(ev).message({ text: '⛔ You are not on the allowlist for Claude Assistant. Ask the owner to add your email to ALLOWED_EMAILS.' });
}

// ---- entry points (add-on default trigger names, plus legacy names) ----

function onAddedToSpace(e) {
  var ev = norm_(e);
  var c = cfg_();
  if (!authorized_(ev, c)) return denied_(ev);
  captureSpace_(ev, c);
  return out_(ev).message({ text: '👋 *Claude Assistant* is connected. Questions from your Claude Code sessions will appear here.\n' + helpText_() });
}

function onAddToSpace(e) {
  return onAddedToSpace(e);
}

function onRemovedFromSpace(e) {
  var ev = norm_(e);
  if (ev.space && ev.space === cfg_().space) props_().deleteProperty('CHAT_SPACE');
  return {};
}

function onRemoveFromSpace(e) {
  return onRemovedFromSpace(e);
}

function onAppCommand(e) {
  return onMessage(e);
}

function onMessage(e) {
  var ev = norm_(e);
  var c = cfg_();
  if (!authorized_(ev, c)) return denied_(ev);
  captureSpace_(ev, c);
  var o = out_(ev);
  var name;
  var args = ev.text;
  if (ev.commandId) {
    name = { 1: 'sessions', 2: 'status', 3: 'pending', 4: 'help', 5: 'cancel', 6: 'reply' }[ev.commandId] || 'help';
    // argumentText of a slash command can still contain the command itself.
    args = args.replace(/^\/\w+\s*/, '');
  } else {
    var m = /^\/?(\w+)\s*([\s\S]*)$/.exec(args.replace(/^@\S+\s+/, ''));
    name = m ? m[1].toLowerCase() : 'help';
    args = m ? m[2] : '';
  }
  switch (name) {
    case 'sessions':
      return o.message({ text: sessionsText_(c) });
    case 'status':
      return o.message({ text: statusText_(c) });
    case 'pending':
      return o.message(pendingMessage_(c));
    case 'cancel':
      return o.message({ text: cmdCancel_(ev, c, args) });
    case 'reply':
    case 'answer':
      return o.message({ text: cmdReply_(ev, c, args) });
    default:
      return o.message({ text: helpText_() });
  }
}

/** Button clicks and dialog submissions. */
function onCardAction(e) {
  var ev = norm_(e);
  var c = cfg_();
  var o = out_(ev);
  if (!authorized_(ev, c)) return denied_(ev);
  var act = ev.params.act;
  var rec = getRec_(ev.params.q);
  if (!rec) return o.message({ text: 'That question is no longer available (archived or unknown).' });
  if (ev.params.s && ev.params.s !== rec.q.sessionId) return o.message({ text: '⛔ Session mismatch for ' + rec.q.id + '.' });
  var offline = bridgeOffline_(c);
  var view = function (r, extra) {
    var opts = { bridgeOffline: offline };
    Object.keys(extra || {}).forEach(function (k) { opts[k] = extra[k]; });
    return questionMessage_(r, opts);
  };

  switch (act) {
    case 'show':
      return o.update(view(rec));
    case 'opt':
      return o.update(view(record_(ev, rec.q.id, 'option', { index: Number(ev.params.i) })));
    case 'allow':
      if (rec.q.permission && rec.q.permission.dangerous && ev.params.c !== '1') return o.update(view(rec, { confirmDanger: true }));
      return o.update(view(record_(ev, rec.q.id, 'allow', { confirmed: ev.params.c === '1' })));
    case 'allowConfirm':
      return o.update(view(rec, { confirmDanger: true }));
    case 'allowSession':
      return o.update(view(record_(ev, rec.q.id, 'allow_session', {})));
    case 'deny':
      return o.update(view(record_(ev, rec.q.id, 'deny', {})));
    case 'cancel':
      return o.update(view(record_(ev, rec.q.id, 'cancel', {})));
    case 'text':
      if (rec.status !== 'PENDING') return o.update(view(rec));
      return o.dialog(textDialog_(rec, 'submitText', rec.q.kind === 'free_text' ? 'Your reply to Claude' : 'Your answer'));
    case 'denyReason':
      if (rec.status !== 'PENDING') return o.update(view(rec));
      return o.dialog(textDialog_(rec, 'submitDeny', 'Why deny? (Claude will see this)'));
    case 'form':
      if (rec.status !== 'PENDING') return o.update(view(rec));
      return o.dialog(formDialog_(rec));
    case 'submitText': {
      var t = formValue_(ev, 'answer');
      if (!t) return o.closeDialog('Nothing sent: the answer was empty.');
      var r1 = record_(ev, rec.q.id, 'text', { text: t });
      return o.closeDialog(r1.lastError || 'Answer sent to ' + rec.q.sessionId + '.', r1.lastError ? null : view(r1));
    }
    case 'submitDeny': {
      var r2 = record_(ev, rec.q.id, 'deny', { message: formValue_(ev, 'answer') || '' });
      return o.closeDialog(r2.lastError || 'Denied.', r2.lastError ? null : view(r2));
    }
    case 'submitForm': {
      var answers = {};
      var missing = [];
      (rec.q.questions || []).forEach(function (x, i) {
        var other = formValue_(ev, 'q' + i + '_other');
        var picked = formValues_(ev, 'q' + i);
        var v = other ? (x.multiSelect ? picked.concat([other]) : other) : x.multiSelect ? picked : picked[0];
        if (!v || (Array.isArray(v) && !v.length)) missing.push(x.question);
        answers[x.question] = v;
      });
      if (missing.length) return o.closeDialog('Not sent — please answer: ' + missing.join('; '));
      var r3 = record_(ev, rec.q.id, 'answers', { answers: answers });
      return o.closeDialog(r3.lastError || 'Answers sent.', r3.lastError ? null : view(r3));
    }
    default:
      return o.update(view(rec));
  }
}

/** Legacy (non add-on) Chat apps deliver all clicks to onCardClick. */
function onCardClick(e) {
  return onCardAction(e);
}

function formValues_(ev, name) {
  var f = ev.form[name];
  return f && f.stringInputs && f.stringInputs.value ? f.stringInputs.value.map(String) : [];
}

function formValue_(ev, name) {
  var v = formValues_(ev, name)[0];
  return v ? String(v).trim() : '';
}

function summarize_(rec, type, value) {
  var q = rec.q;
  if (type === 'option') return (q.options[value.index] && q.options[value.index].label) || 'option ' + (value.index + 1);
  if (type === 'text') return String(value.text).slice(0, 120);
  if (type === 'allow') return 'Allow';
  if (type === 'allow_session') return 'Allow for session';
  if (type === 'deny') return 'Deny' + (value.message ? ': ' + String(value.message).slice(0, 100) : '');
  if (type === 'cancel') return 'Dismissed';
  if (type === 'answers') return Object.keys(value.answers).map(function (k) { return [].concat(value.answers[k]).join(', '); }).join(' | ').slice(0, 200);
  return type;
}

/**
 * Records an answer for the bridge to pick up. Duplicate clicks are rejected because only a
 * PENDING question accepts answers. The bridge re-validates everything before acting.
 */
function record_(ev, qid, type, value) {
  var email = userEmail_(ev) || String(ev.user.name || '');
  return withLock_(function () {
    var rec = getRec_(qid);
    var fail = function (msg) {
      rec.lastError = msg;
      return rec;
    };
    if (rec.status !== 'PENDING') return fail('Already handled: ' + (STATUS_TEXT[rec.status] || rec.status));
    if (Date.now() > rec.q.expiresAt) {
      rec.status = 'EXPIRED';
      saveRec_(rec);
      return fail('This question has expired.');
    }
    var q = rec.q;
    if (type === 'option' && !(value.index >= 0 && value.index < (q.options || []).length)) return fail('Invalid option.');
    if (type === 'text' && (!value.text || String(value.text).length > 4000)) return fail('Answer must be 1–4000 characters.');
    if ((type === 'allow' || type === 'allow_session' || type === 'deny') && q.kind !== 'permission') return fail('Not a permission request.');
    if (type === 'allow' && q.permission && q.permission.dangerous && value.confirmed !== true) return fail('Sensitive operation: confirmation required.');
    if (type === 'allow_session' && !(q.permission && q.permission.allowSession && !q.permission.dangerous)) return fail('"Allow for session" is not available here.');
    var resp = { id: Utilities.getUuid(), questionId: q.id, sessionId: q.sessionId, type: type, value: value, user: email, createdAt: Date.now() };
    props_().setProperty('R_' + resp.id, JSON.stringify(resp));
    CacheService.getScriptCache().put('resp_dirty', '1', 600);
    rec.status = 'ANSWERED';
    rec.answeredBy = email;
    rec.answerSummary = summarize_(rec, type, value);
    rec.note = '';
    saveRec_(rec);
    histAppend_('Responses', [resp.id, new Date(), q.id, q.sessionId, type, JSON.stringify(value).slice(0, 2000), email, '', '']);
    histUpdate_('Questions', q.id, { status: 'ANSWERED', answeredBy: email, answer: rec.answerSummary, updatedAt: new Date() });
    audit_('chat.answer', email, { questionId: q.id, sessionId: q.sessionId, type: type });
    return rec;
  });
}

// ---- text commands ----

function helpText_() {
  return [
    '*Claude Assistant commands*',
    '`/sessions` — list Claude sessions and their state',
    '`/status` — bridge connection status',
    '`/pending` — show unanswered questions with buttons',
    '`/reply <id> <number|text>` — answer by text (permissions: `allow`, `session`, `deny [reason]`)',
    '`/cancel <id>` — dismiss a question',
    '`/help` — this help',
    '',
    'Answers only ever go to an existing pending question; nothing here can run arbitrary commands on your PC.',
  ].join('\n');
}

function bridgeOffline_(c) {
  var b = getJsonProp_('BRIDGE', {});
  return !b.lastSeenAt || Date.now() - b.lastSeenAt > 2 * 60 * 1000;
}

function ago_(ts) {
  if (!ts) return 'never';
  var s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
}

function sessionsText_(c) {
  var snap = getJsonProp_('SESSIONS', { sessions: [] });
  var b = getJsonProp_('BRIDGE', {});
  var lines = ['*Sessions* — bridge ' + (bridgeOffline_(c) ? '🔴 offline' : '🟢 online') + ' (last seen ' + ago_(b.lastSeenAt) + ')'];
  if (!snap.sessions.length) lines.push('_No sessions. Start one on your PC with_ `bridge start "Project"`.');
  snap.sessions.forEach(function (s) {
    var icon = { RUNNING: '🟢', WAITING: '🟡', IDLE: '⚪', STARTING: '🔵', COMPLETED: '✅', FAILED: '❌', STOPPED: '⏹️' }[s.status] || '•';
    lines.push(icon + ' `' + s.id + '`  *' + s.project + '* — ' + s.status + (s.pending ? ' (' + s.pending + ' pending)' : '') + ' · active ' + ago_(s.lastActivityAt));
  });
  return lines.join('\n');
}

function statusText_(c) {
  var b = getJsonProp_('BRIDGE', {});
  var recs = allRecs_();
  var pending = recs.filter(function (r) { return r.status === 'PENDING'; }).length;
  return [
    '*Claude Assistant status*',
    'Bridge: ' + (bridgeOffline_(c) ? '🔴 offline' : '🟢 online') + ' · last seen ' + ago_(b.lastSeenAt) + (b.host ? ' · ' + b.host : '') + (b.version ? ' · v' + b.version : ''),
    'Pending questions: ' + pending,
    'Push mode: ' + c.pushMode + (c.space ? ' · space ' + c.space : ''),
    'Relay version: ' + VERSION,
  ].join('\n');
}

function pendingMessage_(c) {
  var recs = allRecs_().filter(function (r) { return r.status === 'PENDING'; });
  if (!recs.length) return { text: '🎉 No pending questions.' };
  var offline = bridgeOffline_(c);
  return {
    text: recs.length + ' pending question' + (recs.length > 1 ? 's' : '') + (recs.length > 5 ? ' (showing the oldest 5)' : '') + ':',
    cardsV2: recs.slice(0, 5).map(function (r) { return questionCard_(r, { bridgeOffline: offline }); }),
  };
}

function cmdCancel_(ev, c, args) {
  var id = String(args || '').trim().split(/\s+/)[0];
  if (!id) {
    var p = allRecs_().filter(function (r) { return r.status === 'PENDING'; });
    return p.length ? 'Usage: `/cancel <id>`. Pending: ' + p.map(function (r) { return '`' + r.q.id + '` (' + r.q.project + ')'; }).join(', ') : 'No pending questions.';
  }
  var rec = getRec_(id);
  if (!rec) return 'Unknown question `' + id + '`.';
  var r = record_(ev, id, 'cancel', {});
  return r.lastError ? r.lastError : '🚫 Dismissed `' + id + '`.';
}

function cmdReply_(ev, c, args) {
  var m = /^\s*(q[a-z0-9]{4,10})\s+([\s\S]+)$/i.exec(args || '');
  if (!m) return 'Usage: `/reply <question id> <number | text>` — e.g. `/reply q7k2m 1`.';
  var rec = getRec_(m[1].toLowerCase());
  if (!rec) return 'Unknown question `' + m[1] + '`.';
  var a = parseAnswer_(rec, m[2]);
  if (a.error) return a.error;
  var r = record_(ev, rec.q.id, a.type, a.value);
  return r.lastError ? '⚠️ ' + r.lastError : '📨 Sent to `' + rec.q.sessionId + '`: ' + r.answerSummary;
}

/** Turns a typed answer ("1", "allow", "deny reason", free text) into a response for record_(). */
function parseAnswer_(rec, text) {
  var v = String(text || '').trim();
  var q = rec.q;
  if (!v) return { error: 'Empty answer.' };
  if (q.kind === 'permission') {
    var word = v.split(/\s+/)[0].toLowerCase();
    var rest = v.slice(word.length).trim();
    if (word === 'allow' || word === 'yes' || word === 'approve') {
      if (q.permission && q.permission.dangerous && rest.toLowerCase() !== 'confirm') return { error: '⚠️ Sensitive operation. To approve, answer `allow confirm` (reply to ' + q.id + ').' };
      return { type: 'allow', value: { confirmed: true } };
    }
    if (word === 'session') return { type: 'allow_session', value: {} };
    if (word === 'deny' || word === 'no') return { type: 'deny', value: { message: rest } };
    return { error: 'For permission requests answer `allow`, `session` or `deny [reason]`.' };
  }
  if (/^(dismiss|cancel)$/i.test(v)) return { type: 'cancel', value: {} };
  if (/^\d+$/.test(v) && (q.options || []).length) return { type: 'option', value: { index: Number(v) - 1 } };
  if (q.kind === 'ask_user_question' && q.questions && q.questions.length > 1) {
    return { error: 'This question has several parts — use the "Answer" link (or /pending in Chat).' };
  }
  if (q.allowText || q.kind === 'ask_user_question') return { type: 'text', value: { text: v } };
  return { error: 'This prompt only accepts an option number (1–' + (q.options || []).length + ').' };
}

// =====================================================================================
// Housekeeping (time-driven trigger installed by setup())
// =====================================================================================

function housekeeping() {
  var c = cfg_();
  var now = Date.now();
  var b = getJsonProp_('BRIDGE', {});
  if (b.paused) {
    // The bridge uses other channels: only tidy up, never email or post.
    allRecs_().forEach(function (rec) {
      if (rec.status === 'PENDING' && now > rec.q.expiresAt) {
        rec.status = 'EXPIRED';
        saveRec_(rec);
      } else if (TERMINAL.indexOf(rec.status) >= 0 && now - rec.updatedAt > 2 * 24 * 3600 * 1000) {
        props_().deleteProperty('Q_' + rec.q.id);
      }
    });
    return;
  }
  if (c.pushMode === 'gmail') scanGmail_(c);
  if (b.lastSeenAt && !b.offlineNotified && now - b.lastSeenAt > c.offlineAfterMin * 60000) {
    b.offlineNotified = true;
    setJsonProp_('BRIDGE', b);
    push_(c, { text: '🔴 *Bridge disconnected* — no contact from your PC for ' + c.offlineAfterMin + ' minutes (last seen ' + ago_(b.lastSeenAt) + '). Answers you send are kept and delivered when it reconnects.' }, null);
  }
  allRecs_().forEach(function (rec) {
    if (rec.status === 'PENDING' && now > rec.q.expiresAt) {
      rec.status = 'EXPIRED';
      saveRec_(rec);
      refreshPushedCard_(c, rec);
    } else if (rec.status === 'PENDING' && !rec.reminded && now - rec.q.createdAt > c.remindAfterMin * 60000) {
      rec.reminded = true;
      saveRec_(rec);
      push_(c, { text: '⏰ *Still waiting for you:* `' + rec.q.id + '` — ' + rec.q.title + ' (' + rec.q.project + ', ' + rec.q.sessionId + '). Use `/pending`.' }, null);
    } else if (rec.status === 'PENDING' && !rec.messageName && (rec.pushAttempts || 0) < 5 && c.pushMode !== 'none') {
      pushQuestion_(c, rec);
    } else if (TERMINAL.indexOf(rec.status) >= 0 && now - rec.updatedAt > 2 * 24 * 3600 * 1000) {
      props_().deleteProperty('Q_' + rec.q.id); // history stays in the spreadsheet
    }
  });
  pendingResponses_().forEach(function (r) {
    if (now - r.createdAt > 7 * 24 * 3600 * 1000) props_().deleteProperty('R_' + r.id);
  });
}

// =====================================================================================
// One-time setup: run `setup` from the Apps Script editor
// =====================================================================================

function setup() {
  var p = props_();
  if (!p.getProperty('SHARED_SECRET')) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
    p.setProperty('SHARED_SECRET', Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''));
    console.log('Generated SHARED_SECRET. Copy it into BRIDGE_SHARED_SECRET on your PC: ' + p.getProperty('SHARED_SECRET'));
  }
  if (!p.getProperty('SPREADSHEET_ID')) {
    var ss = SpreadsheetApp.create('Claude Assistant — bridge history');
    p.setProperty('SPREADSHEET_ID', ss.getId());
    var first = ss.getSheets()[0];
    first.setName('Questions');
    first.appendRow(HEADERS.Questions);
    console.log('Created history spreadsheet: ' + ss.getUrl());
  }
  ['Questions', 'Responses', 'Audit'].forEach(function (n) { sheet_(n, HEADERS[n]); });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'housekeeping') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('housekeeping').timeBased().everyMinutes(5).create();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'gmailPoll') ScriptApp.deleteTrigger(t);
  });
  if (cfg_().pushMode === 'gmail') ScriptApp.newTrigger('gmailPoll').timeBased().everyMinutes(1).create();
  var c = cfg_();
  console.log('Setup complete. Push mode: ' + c.pushMode + '. Allowed emails: ' + (c.allowed.join(', ') || '(none — set ALLOWED_EMAILS!)'));
}

// =====================================================================================
// Gmail delivery (PUSH_MODE=gmail): no Chat app, no service account, no admin approval.
//   • each question is an email thread "[Claude q7k2m] …" sent from and to your own account
//   • answer by tapping a link (ANSWER_URL deployment, identity-checked, with a Confirm step)
//   • or by replying to the email: "1", "allow", "deny reason", or any text
//   • commands: send yourself an email with subject "claude sessions" / "claude pending" / …
// =====================================================================================

var BOT_MARK = '[Claude Assistant]';

/**
 * Plain-text email bodies sent by Apps Script can garble emoji outside the Basic Multilingual Plane
 * (they show up as "������"). Plain-text parts therefore drop them; the HTML part keeps them.
 */
function plain_(s) {
  return String(s || '')
    .replace(/(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF\u23F0-\u23FF\u2B00-\u2BFF])[\uFE0F\u200D]*[ ]?/g, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/[ \t]+\n/g, '\n');
}

/**
 * GmailApp mis-encodes characters outside the Basic Multilingual Plane (most emoji: 💬 🔔 📂 📨 💻)
 * in email bodies AND subjects; they arrive as "������". In HTML they are written as numeric
 * entities (pure ASCII, rendered back to emoji by every mail client); subjects drop them.
 */
function htmlSafe_(html) {
  return String(html || '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function (pair) {
    var cp = (pair.charCodeAt(0) - 0xd800) * 0x400 + (pair.charCodeAt(1) - 0xdc00) + 0x10000;
    return '&#x' + cp.toString(16).toUpperCase() + ';';
  });
}

function subjectSafe_(subject) {
  return String(subject || '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF][\uFE0F\u200D]*\s?/g, '').trim();
}

function notifyAddress_(c) {
  return c.notifyEmail || (c.allowed[0] || '') || Session.getEffectiveUser().getEmail();
}

function ownerAddress_() {
  return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

/**
 * Sends through MailApp, which has its own daily recipient quota and does not use the GmailApp
 * ("premium gmail") call quota that reading replies needs.
 */
function sendMail_(c, subject, text, html) {
  try {
    MailApp.sendEmail({
      to: notifyAddress_(c),
      subject: subjectSafe_(/^\[Claude/.test(subject) ? subject : '[Claude] ' + subject),
      body: plain_(BOT_MARK + '\n\n' + String(text || '').replace(/[*`]/g, '')),
      htmlBody: htmlSafe_(html || notificationHtml_(subject, text)),
      name: 'Claude Assistant',
    });
    return { ok: true, name: 'gmail' };
  } catch (e) {
    return { ok: false, error: 'Email send failed: ' + (e.message || e) };
  }
}

function answerToken_(qid, act, i) {
  return hmacHex_(cfg_().secret, 'answer.' + qid + '.' + act + '.' + (i === undefined || i === null ? '' : i)).slice(0, 32);
}

function answerLink_(c, rec, act, i) {
  if (!c.answerUrl) return '';
  var q = rec.q;
  var params = { page: 'answer', q: q.id, s: q.sessionId, a: act, t: answerToken_(q.id, act, i) };
  if (i !== undefined && i !== null) params.i = String(i);
  return c.answerUrl + '?' + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
}

/** The answer choices offered for a question (shared by emails and the answer page). */
function answerChoices_(rec) {
  var q = rec.q;
  var out = [];
  var multi = q.kind === 'ask_user_question' && q.questions && (q.questions.length > 1 || (q.questions[0] && q.questions[0].multiSelect));
  if (q.kind === 'permission') {
    out.push({ act: 'allow', label: '✅ Allow' });
    if (q.permission && q.permission.allowSession && !q.permission.dangerous) out.push({ act: 'allowSession', label: '✅ Allow for session' });
    out.push({ act: 'deny', label: '❌ Deny' });
  } else if (multi) {
    out.push({ act: 'form', label: '📝 Answer' });
    out.push({ act: 'cancel', label: 'Dismiss' });
  } else {
    (q.options || []).forEach(function (o, i) { out.push({ act: 'opt', i: i, label: optionLabel_(i, o.label) }); });
    if (q.allowText) out.push({ act: 'text', label: q.kind === 'free_text' ? '✏️ Reply with text' : '✏️ Type something' });
    out.push({ act: 'cancel', label: q.kind === 'menu' || q.kind === 'yes_no' || q.kind === 'text_prompt' ? 'Leave for terminal' : 'Dismiss' });
  }
  return out;
}

function replyHelp_(rec) {
  var q = rec.q;
  if (q.kind === 'permission') return 'allow' + (q.permission && q.permission.dangerous ? ' confirm' : '') + (q.permission && q.permission.allowSession && !q.permission.dangerous ? ' · session' : '') + ' · deny <reason>';
  if ((q.options || []).length) return 'an option number (1–' + q.options.length + ')' + (q.allowText ? ' or your own text' : '') + ' · dismiss';
  return 'your answer as text · dismiss';
}

/** Subject starts with the session name so you can tell sessions apart in the inbox. */
function emailSubject_(rec) {
  var q = rec.q;
  var finished = q.kind === 'free_text' && /^✅/.test(q.title || '');
  var label = finished ? '✅ Finished' : { ask_user_question: '❓ Question', permission: q.permission && q.permission.dangerous ? '⚠️ Sensitive permission' : '🔐 Permission', free_text: '💬 Waiting for you', menu: '🖥️ Terminal menu', yes_no: '🖥️ Yes/No', text_prompt: '🖥️ Terminal input' }[q.kind] || 'Question';
  var what = finished && q.context && q.context.task
    ? String(q.context.task).replace(/\s+/g, ' ')
    : q.kind === 'permission' && q.permission
    ? q.permission.tool + ' ' + String(q.permission.summary).split('\n')[0]
    : String((q.questions && q.questions[0] && q.questions[0].question) || q.text).split('\n')[0];
  if (what.length > 70) what = what.slice(0, 69) + '…';
  return '[Claude · ' + (q.project || q.sessionId) + '] ' + label + ': ' + what + ' (' + q.id + ')';
}

function folderName_(cwd) {
  var parts = String(cwd || '').split(/[\\/]/).filter(function (x) { return !!x; });
  return parts.length ? parts[parts.length - 1] : '';
}

// ---- email design (table layout + inline styles: renders in Gmail web, iOS and Android) ----

var THEMES = {
  question: { color: '#1a73e8', soft: '#e8f0fe', icon: '❓', label: 'Question' },
  permission: { color: '#e37400', soft: '#fef7e0', icon: '🔐', label: 'Permission request' },
  danger: { color: '#d93025', soft: '#fce8e6', icon: '⚠️', label: 'Sensitive operation' },
  turn: { color: '#188038', soft: '#e6f4ea', icon: '💬', label: 'Claude is waiting for you' },
  done: { color: '#188038', soft: '#e6f4ea', icon: '✅', label: 'Task finished' },
  terminal: { color: '#5f6368', soft: '#f1f3f4', icon: '🖥️', label: 'Terminal prompt' },
  info: { color: '#5f6368', soft: '#f1f3f4', icon: '🔔', label: 'Notification' },
};

function themeFor_(q) {
  if (q.kind === 'permission') return q.permission && q.permission.dangerous ? THEMES.danger : THEMES.permission;
  if (q.kind === 'ask_user_question') return THEMES.question;
  if (q.kind === 'free_text') return /^✅/.test(q.title || '') ? THEMES.done : THEMES.turn;
  return THEMES.terminal;
}

/** Tiny markdown → HTML for Claude's messages: **bold**, `code`, ``` blocks, bullet/numbered lines. */
function mdLite_(text) {
  var parts = String(text || '').split('```');
  return parts.map(function (part, i) {
    if (i % 2 === 1) {
      return '<pre style="margin:8px 0;padding:10px 12px;background:#202124;color:#e8eaed;border-radius:6px;font:12px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word">' + esc_(part.replace(/^\w*\n/, '')) + '</pre>';
    }
    return esc_(part)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code style="background:#f1f3f4;border-radius:4px;padding:1px 5px;font:13px Menlo,Consolas,monospace">$1</code>')
      .replace(/^(\s*)[-*] /gm, '$1• ')
      .replace(/\n/g, '<br>');
  }).join('');
}

function emailLayout_(theme, title, meta, bodyHtml, footerHtml) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f3f4">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f4;padding:24px 12px"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dadce0;font-family:Roboto,Arial,Helvetica,sans-serif;color:#202124">' +
    '<tr><td style="background:' + theme.color + ';padding:18px 24px;color:#ffffff">' +
    '<div style="font-size:12px;letter-spacing:.6px;text-transform:uppercase;opacity:.9">' + theme.icon + '&nbsp; ' + esc_(theme.label) + '</div>' +
    '<div style="font-size:20px;font-weight:bold;line-height:1.3;margin-top:4px">' + esc_(title) + '</div>' +
    (meta ? '<div style="font-size:13px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.3)">' + meta + '</div>' : '') +
    '</td></tr>' +
    '<tr><td style="padding:22px 24px;font-size:15px;line-height:1.55">' + bodyHtml + '</td></tr>' +
    '<tr><td style="padding:14px 24px;background:#f8f9fa;border-top:1px solid #e8eaed;font-size:12px;line-height:1.6;color:#5f6368">' + (footerHtml || '') +
    '<div>Claude Assistant · sent by your claude-chat-bridge</div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

function chip_(text) {
  return '<span style="display:inline-block;background:rgba(255,255,255,.22);border-radius:10px;padding:2px 9px;margin-right:6px">' + esc_(text) + '</span>';
}

function buttonHtml_(href, label, theme, primary) {
  return '<a href="' + esc_(href) + '" style="display:inline-block;margin:0 8px 10px 0;padding:10px 18px;border-radius:20px;font-size:14px;font-weight:bold;text-decoration:none;' +
    (primary ? 'background:' + theme.color + ';color:#ffffff;border:1px solid ' + theme.color : 'background:#ffffff;color:' + theme.color + ';border:1px solid #dadce0') + '">' + esc_(label) + '</a>';
}

function optionRows_(c, rec, theme, opts) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px">' + opts.map(function (o, i) {
    var link = c.answerUrl ? answerLink_(c, rec, 'opt', i) : '';
    var action = link
      ? '<a href="' + esc_(link) + '" style="display:inline-block;padding:7px 14px;border-radius:16px;background:' + theme.color + ';color:#fff;font-size:13px;font-weight:bold;text-decoration:none">Choose</a>'
      : '<span style="font-size:12px;color:#5f6368">reply <b>' + (i + 1) + '</b></span>';
    return '<tr><td style="padding:5px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dadce0;border-radius:10px"><tr>' +
      '<td width="38" valign="top" style="padding:12px 0 12px 12px"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:' + theme.soft + ';color:' + theme.color + ';font-weight:bold;text-align:center;font-size:13px">' + (i + 1) + '</div></td>' +
      '<td style="padding:12px 10px"><div style="font-weight:bold">' + esc_(o.label) + '</div>' + (o.description ? '<div style="font-size:13px;color:#5f6368;margin-top:2px">' + esc_(o.description) + '</div>' : '') + '</td>' +
      '<td width="1" align="right" style="padding:12px;white-space:nowrap">' + action + '</td></tr></table></td></tr>';
  }).join('') + '</table>';
}

function replyGuide_(rec) {
  var q = rec.q;
  var rows = [];
  if (q.kind === 'permission') {
    rows.push(['allow' + (q.permission && q.permission.dangerous ? ' confirm' : ''), 'approve once']);
    if (q.permission && q.permission.allowSession && !q.permission.dangerous) rows.push(['session', 'approve for the rest of this session']);
    rows.push(['deny &lt;reason&gt;', 'refuse (Claude sees the reason)']);
  } else {
    if ((q.options || []).length) rows.push(['1 – ' + q.options.length, 'pick an option']);
    if (q.allowText || q.kind === 'ask_user_question') rows.push(['any text', q.kind === 'free_text' ? 'your next instruction — typed into Claude' : 'your own answer']);
    rows.push(['dismiss', 'skip / leave it for the terminal']);
  }
  return '<div style="margin-top:18px;padding:12px 14px;background:#f8f9fa;border-radius:8px;font-size:13px">' +
    '<div style="font-weight:bold;margin-bottom:6px">↩️ Or simply reply to this email with:</div>' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' + rows.map(function (r) {
      return '<tr><td style="padding:2px 14px 2px 0"><code style="background:#ffffff;border:1px solid #dadce0;border-radius:4px;padding:1px 6px;font:12px Menlo,Consolas,monospace">' + r[0] + '</code></td><td style="padding:2px 0;color:#5f6368">' + r[1] + '</td></tr>';
    }).join('') + '</table></div>';
}

/** "You asked / What Claude did / What Claude said" — so the email makes sense on its own. */
function contextHtml_(q, theme) {
  var x = q.context;
  if (!x) return '';
  var h = [];
  var box = function (label, inner) {
    return '<div style="margin:0 0 14px"><div style="font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:#5f6368;font-weight:bold;margin-bottom:4px">' + label + '</div>' + inner + '</div>';
  };
  if (x.task) {
    h.push(box('📝 You asked', '<div style="background:#f8f9fa;border:1px solid #e8eaed;border-radius:8px;padding:10px 12px;font-size:14px">' + mdLite_(x.task) + '</div>'));
  }
  if (x.actions && x.actions.length) {
    h.push(box('🔧 What Claude did', '<ul style="margin:0;padding-left:20px;font-size:14px;color:#3c4043">' + x.actions.map(function (a) {
      return '<li style="margin:2px 0">' + esc_(a).replace(/^(Ran|Edited|Wrote|Read|Searched|Fetched|Delegated|Used)\b/, '<b>$1</b>') + '</li>';
    }).join('') + '</ul>'));
  }
  if (x.lastMessage && q.kind !== 'free_text') {
    h.push(box('💬 Claude said before asking', '<div style="border-left:4px solid ' + theme.soft + ';padding:2px 12px;font-size:14px;color:#3c4043">' + mdLite_(x.lastMessage) + '</div>'));
  }
  return h.length ? h.join('') + '<div style="border-top:1px solid #e8eaed;margin:4px 0 16px"></div>' : '';
}

function emailHtml_(c, rec) {
  var q = rec.q;
  var theme = themeFor_(q);
  var p = q.permission;
  var meta = '<div style="font-size:15px;font-weight:bold;margin-top:2px">📂 ' + esc_(q.project || 'Claude session') + '</div>' +
    '<div style="margin-top:6px">' + chip_(q.sessionId) + (q.cwd ? chip_('folder: ' + folderName_(q.cwd)) : '') + chip_('id ' + q.id) + '</div>';
  var body = [contextHtml_(q, theme)];
  var multi = q.kind === 'ask_user_question' && q.questions && (q.questions.length > 1 || (q.questions[0] && q.questions[0].multiSelect));

  if (q.kind === 'permission' && p) {
    var tool = p.tool === 'Bash' || p.tool === 'PowerShell' ? 'Run this command' : p.tool === 'ExitPlanMode' ? 'Approve this plan' : 'Use ' + p.tool;
    body.push('<div style="font-size:13px;color:#5f6368;margin-bottom:6px">' + esc_(tool) + '</div>');
    if (p.tool === 'ExitPlanMode') body.push('<div style="border-left:4px solid ' + theme.color + ';padding:4px 12px">' + mdLite_(p.detail || p.summary) + '</div>');
    else body.push('<pre style="margin:0 0 10px;padding:12px 14px;background:#202124;color:#e8eaed;border-radius:8px;font:13px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word">' + esc_(p.summary) + '</pre>');
    if (p.detail && p.tool !== 'ExitPlanMode') body.push('<div style="color:#5f6368;font-size:14px">' + esc_(p.detail) + '</div>');
    if (p.dangerous) body.push('<div style="margin-top:12px;padding:10px 12px;background:' + THEMES.danger.soft + ';border-radius:8px;color:' + THEMES.danger.color + ';font-size:14px"><b>⚠️ Sensitive operation:</b> ' + esc_((p.reasons || []).join(', ')) + '<br><span style="font-size:13px">Approving asks you to confirm once more.</span></div>');
    if (c.answerUrl) {
      body.push('<div style="margin-top:18px">');
      body.push(buttonHtml_(answerLink_(c, rec, 'allow'), '✅ Allow', theme, true));
      if (p.allowSession && !p.dangerous) body.push(buttonHtml_(answerLink_(c, rec, 'allowSession'), 'Allow for session', theme, false));
      body.push(buttonHtml_(answerLink_(c, rec, 'deny'), '❌ Deny', theme, false));
      body.push('</div>');
    }
  } else if (q.kind === 'ask_user_question' && q.questions && q.questions.length) {
    q.questions.forEach(function (x, k) {
      if (x.header) body.push('<div style="font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:' + theme.color + ';font-weight:bold">' + esc_(x.header) + '</div>');
      body.push('<div style="font-size:17px;font-weight:bold;margin:2px 0 8px">' + esc_(x.question) + (x.multiSelect ? ' <span style="font-size:13px;font-weight:normal;color:#5f6368">(choose any)</span>' : '') + '</div>');
      if (multi) body.push(optionRowsStatic_(theme, x.options || []) + (k < q.questions.length - 1 ? '<div style="height:14px"></div>' : ''));
    });
    if (!multi) body.push(optionRows_(c, rec, theme, q.options || []));
    if (c.answerUrl) {
      body.push('<div style="margin-top:12px">');
      if (multi) body.push(buttonHtml_(answerLink_(c, rec, 'form'), '📝 Answer', theme, true));
      else body.push(buttonHtml_(answerLink_(c, rec, 'text'), '✏️ Type my own answer', theme, false));
      body.push(buttonHtml_(answerLink_(c, rec, 'cancel'), 'Dismiss', theme, false));
      body.push('</div>');
    }
  } else if (q.kind === 'free_text') {
    body.push('<div style="font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:#5f6368;font-weight:bold;margin-bottom:4px">' + (/^✅/.test(q.title || '') ? '✅ Claude\'s summary' : '💬 Claude\'s message') + '</div>');
    body.push('<div style="border-left:4px solid ' + theme.color + ';background:#fafafa;border-radius:0 8px 8px 0;padding:10px 14px">' + mdLite_(q.text) + '</div>');
    if ((q.options || []).length) {
      body.push('<div style="font-weight:bold;margin:16px 0 4px">Quick answers</div>');
      body.push(optionRows_(c, rec, theme, q.options));
    }
    if (c.answerUrl) body.push('<div style="margin-top:12px">' + buttonHtml_(answerLink_(c, rec, 'text'), '✏️ Reply to Claude', theme, true) + buttonHtml_(answerLink_(c, rec, 'cancel'), 'Dismiss', theme, false) + '</div>');
  } else {
    body.push('<pre style="margin:0 0 10px;padding:12px 14px;background:#f8f9fa;border:1px solid #e8eaed;border-radius:8px;font:13px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap">' + esc_(q.text) + '</pre>');
    if ((q.options || []).length) body.push(optionRows_(c, rec, theme, q.options));
    if (c.answerUrl) body.push('<div style="margin-top:12px">' + (q.allowText ? buttonHtml_(answerLink_(c, rec, 'text'), '✏️ Type an answer', theme, true) : '') + buttonHtml_(answerLink_(c, rec, 'cancel'), 'Leave for terminal', theme, false) + '</div>');
  }
  body.push(replyGuide_(rec));
  var footer = (q.cwd ? '<div>📁 ' + esc_(q.project || '') + ' runs in <code>' + esc_(q.cwd) + '</code></div>' : '') +
    '<div>⏳ Expires at <b>' + fmtTime_(q.expiresAt) + '</b> — after that the terminal shows its own prompt.</div>' +
    '<div>🔒 Answers only go to this pending question' + (c.answerUrl ? '; buttons open a confirmation page' : '') + '.</div>';
  return emailLayout_(theme, String(q.title || 'Claude needs your input').replace(/^✅\s*/, ''), meta, body.join(''), footer);
}

function optionRowsStatic_(theme, opts) {
  return opts.map(function (o) {
    return '<div style="padding:6px 0 6px 10px;border-left:3px solid ' + theme.soft + '"><b>' + esc_(o.label) + '</b>' + (o.description ? ' <span style="color:#5f6368;font-size:13px">— ' + esc_(o.description) + '</span>' : '') + '</div>';
  }).join('');
}

/** Notifications (session finished, bridge offline, reminders…) in the same design. */
function notificationHtml_(subject, text) {
  var t = /❌|failed|terminated|disconnected|⚠️/i.test(subject) ? THEMES.danger : /✅|completed|reconnected/i.test(subject) ? THEMES.turn : THEMES.info;
  return emailLayout_(t, subject.replace(/^[^\w]+\s*/, ''), '', mdLite_(String(text || '').replace(/^\*[^*]+\*[^\n]*\n?/, '')), '');
}

function emailText_(rec) {
  var q = rec.q;
  var lines = [BOT_MARK + ' · ' + (q.project || '') + ' · ' + q.sessionId + ' · ' + q.id, '', q.title || 'Claude needs your input', ''];
  if (q.context && q.context.task) lines.push('You asked: ' + q.context.task, '');
  if (q.context && q.context.actions && q.context.actions.length) lines.push('What Claude did:', q.context.actions.map(function (a) { return '- ' + a; }).join('\n'), '');
  if (q.kind === 'permission' && q.permission) {
    lines.push(q.permission.tool + ': ' + q.permission.summary);
    if (q.permission.dangerous) lines.push('⚠️ Sensitive: ' + (q.permission.reasons || []).join(', '));
  } else {
    lines.push(q.text);
    (q.options || []).forEach(function (o, i) { lines.push((i + 1) + '. ' + o.label); });
  }
  lines.push('', 'Reply with: ' + replyHelp_(rec));
  return lines.join('\n');
}

function pushQuestionEmail_(c, rec) {
  var subject = subjectSafe_(emailSubject_(rec));
  var r;
  try {
    MailApp.sendEmail({ to: notifyAddress_(c), subject: subject, body: plain_(emailText_(rec)), htmlBody: htmlSafe_(emailHtml_(c, rec)), name: 'Claude Assistant' });
    r = { ok: true, name: 'gmail' };
  } catch (e) {
    r = { ok: false, error: 'Email send failed: ' + (e.message || e) };
  }
  withLock_(function () {
    var cur = getRec_(rec.q.id) || rec;
    cur.pushAttempts = (cur.pushAttempts || 0) + 1;
    if (r.ok) {
      cur.messageName = 'gmail';
      cur.subject = subject;
    }
    saveRec_(cur);
  });
  return r;
}

/** The question's email thread (found once by its "(q…)" subject suffix, then remembered). */
function threadOf_(rec) {
  try {
    if (rec.threadId) return GmailApp.getThreadById(rec.threadId);
    var found = GmailApp.search('subject:"(' + rec.q.id + ')"', 0, 1)[0];
    if (found) {
      withLock_(function () {
        var cur = getRec_(rec.q.id);
        if (cur) { cur.threadId = found.getId(); saveRec_(cur); }
      });
    }
    return found || null;
  } catch (e) {
    return null;
  }
}

function botReply_(thread, text) {
  var t = String(text).replace(/[*`]/g, '');
  thread.reply(plain_(BOT_MARK + '\n\n' + t), {
    htmlBody: htmlSafe_('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div style="font-family:Roboto,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124;padding:12px 16px;border-left:4px solid #1a73e8;background:#f8f9fa;border-radius:0 8px 8px 0;max-width:600px">' +
      '<div style="font-size:12px;color:#5f6368;margin-bottom:4px">' + esc_(BOT_MARK) + '</div>' + esc_(t).replace(/\n/g, '<br>') + '</div></body></html>'),
  });
}

/** Keeps the email thread in sync: problems are replied in-thread, resolved threads are labelled + read. */
function refreshEmail_(c, rec) {
  var needNote = rec.note && rec.note !== rec.mailedNote;
  var needLabel = TERMINAL.indexOf(rec.status) >= 0 && !rec.labelled;
  if (!needNote && !needLabel) return; // no Gmail calls unless something changed
  var thread = threadOf_(rec);
  if (!thread) return;
  var updates = {};
  if (needNote) {
    botReply_(thread, '⚠️ ' + rec.note);
    updates.mailedNote = rec.note;
  }
  if (needLabel) {
    try {
      var name = 'Claude Assistant/' + ({ DELIVERED: 'Answered', ANSWERED_LOCALLY: 'Answered in terminal', EXPIRED: 'Expired', CANCELLED: 'Dismissed', FAILED: 'Not delivered' }[rec.status] || rec.status);
      thread.addLabel(GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name));
      thread.markRead();
    } catch (e) {
      console.warn('label failed: ' + e);
    }
    updates.labelled = true;
  }
  withLock_(function () {
    var cur = getRec_(rec.q.id);
    if (!cur) return;
    Object.keys(updates).forEach(function (k) { cur[k] = updates[k]; });
    saveRec_(cur);
  });
}

/**
 * Keeps only what you typed: removes quoted history ("On … wrote:", "> …", forwarded headers) and
 * your email signature. Signature detection: a "-- " separator, a line that is only a link (logo /
 * social icons), your name or email address alone on a line, common sign-offs and "Sent from my …"
 * footers, or the text in the optional SIGNATURE_MARKER Script Property.
 */
function stripQuoted_(body, from) {
  var fromStr = String(from || '');
  var name = (/^\s*"?([^"<]+?)"?\s*</.exec(fromStr) || [])[1] || '';
  var addr = ((/<([^>]+)>/.exec(fromStr) || [])[1] || fromStr).trim().toLowerCase();
  var marker = String(props_().getProperty('SIGNATURE_MARKER') || '').trim().toLowerCase();
  var out = [];
  var lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var t = l.trim();
    var low = t.toLowerCase();
    // quoted history
    if (/^>/.test(t) || /wrote:\s*$/.test(t) || /^-{2,}\s*(original|forwarded) message/i.test(t) || /^From:\s/.test(t) || /^On .{6,}(\d{4}|AM|PM)/.test(t) || t.indexOf(BOT_MARK) === 0) break;
    // signature
    if (/^(--|—|__+)\s*$/.test(l) || l === '-- ') break;
    if (marker && low.indexOf(marker) >= 0) break;
    var hasText = out.join('').trim().length > 0;
    if (hasText) {
      if (/^<?https?:\/\/\S+>?$/.test(t)) break; // logo / social links
      if (addr && low === addr) break;
      if (name && low === name.trim().toLowerCase()) break;
      if (/^(regards|best regards|kind regards|warm regards|thanks|thank you|thanks & regards|cheers|best)[,!.]?$/i.test(t)) break;
      if (/^(sent from my|get outlook for)\b/i.test(t)) break;
    }
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * True only for messages sent from the script owner's own account (they are in the owner's Sent
 * mail). A forged "From:" by someone else never lands in your Sent folder.
 */
function isSentByOwner_(m) {
  try {
    if (String(m.getFrom()).toLowerCase().indexOf(ownerAddress_()) < 0) return false;
    var mid = String(m.getHeader('Message-ID') || '').replace(/[<>]/g, '');
    if (!mid) return false;
    return GmailApp.search('in:sent rfc822msgid:' + mid, 0, 1).length > 0;
  } catch (e) {
    return false;
  }
}

/** Time-driven trigger (every minute) installed by setup() in gmail mode. */
function gmailPoll() {
  var c = cfg_();
  if (c.pushMode !== 'gmail' || relayPaused_()) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a previous scan is still running
  lock.releaseLock();
  scanGmail_(c);
}

/**
 * Reads your email replies with as few Gmail calls as possible: ONE search for threads with mail
 * you sent since the last scan (subject contains "Claude"), then only those threads are opened.
 * Handles question replies ("(q…)" in the subject) and commands ("claude sessions", …).
 */
function scanGmail_(c) {
  var me = ownerAddress_();
  var now = Math.floor(Date.now() / 1000);
  var since = Number(props_().getProperty('GMAIL_LAST_SCAN')) || now - 600;
  var seen = getJsonProp_('GMAIL_SEEN', []);
  var seenSet = {};
  seen.forEach(function (id) { seenSet[id] = true; });
  var threads = GmailApp.search('in:sent after:' + (since - 120) + ' subject:claude', 0, 30);
  threads.forEach(function (thread) {
    var msgs = thread.getMessages();
    var subject = msgs[0].getSubject() || '';
    var qm = /\((q[a-z0-9]{4,10})\)\s*$/.exec(subject);
    var cm = /^\s*claude\s+(sessions|status|pending|help)\b/i.exec(subject);
    if (!qm && !cm) return;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var id = m.getId();
      if (seenSet[id]) continue;
      seenSet[id] = true;
      seen.push(id);
      var body = String(m.getPlainBody() || '');
      if (body.indexOf(BOT_MARK) === 0) continue; // our own emails
      if (cm && i === 0) {
        if (!isSentByOwner_(m)) continue;
        var cmd = cm[1].toLowerCase();
        botReply_(thread, cmd === 'sessions' ? sessionsText_(c) : cmd === 'status' ? statusText_(c) : cmd === 'pending' ? pendingEmailText_(c) : emailHelpText_());
        continue;
      }
      if (!qm) continue;
      var text = stripQuoted_(body, m.getFrom());
      if (!text) continue;
      if (!isSentByOwner_(m)) {
        audit_('gmail.reply_ignored', String(m.getFrom()), { questionId: qm[1], reason: 'not sent from the owner account' });
        continue;
      }
      var rec = getRec_(qm[1]);
      if (!rec) {
        botReply_(thread, 'This question is no longer known to Claude Assistant (archived). Your reply was NOT sent to Claude.');
        continue;
      }
      if (!rec.threadId) {
        withLock_(function () {
          var cur = getRec_(rec.q.id);
          if (cur) { cur.threadId = thread.getId(); saveRec_(cur); }
        });
      }
      if (rec.status !== 'PENDING') {
        // Never silent: explain why this reply was not passed to Claude.
        botReply_(thread, 'This question was already handled — ' + (STATUS_TEXT[rec.status] || rec.status) +
          (rec.answerSummary ? ': ' + rec.answerSummary : '') + (rec.note ? ' (' + rec.note + ')' : '') +
          '.\nYour reply was NOT sent to Claude. If Claude asks again you will get a new email.');
        audit_('gmail.reply_too_late', me, { questionId: rec.q.id, status: rec.status });
        continue;
      }
      var a = parseAnswer_(rec, text);
      if (a.error) {
        botReply_(thread, a.error + '\nReply with: ' + replyHelp_(rec));
        continue;
      }
      var r = record_({ addon: false, user: { email: me } }, rec.q.id, a.type, a.value);
      botReply_(thread, r.lastError ? '⚠️ ' + r.lastError : '📨 Got it: ' + r.answerSummary + ' — delivering to ' + rec.q.sessionId + '.');
    }
  });
  setJsonProp_('GMAIL_SEEN', seen.slice(-300));
  props_().setProperty('GMAIL_LAST_SCAN', String(now));
}

function pendingEmailText_(c) {
  var recs = allRecs_().filter(function (r) { return r.status === 'PENDING'; });
  if (!recs.length) return '🎉 No pending questions.';
  return recs.map(function (r) {
    var links = c.answerUrl ? '\n' + answerChoices_(r).map(function (ch) { return '   ' + ch.label + ': ' + answerLink_(c, r, ch.act, ch.i); }).join('\n') : '';
    return '• ' + r.q.id + ' — ' + r.q.title + ' (' + r.q.project + ', ' + r.q.sessionId + ')\n  ' + String(r.q.text).split('\n')[0].slice(0, 140) + links;
  }).join('\n\n') + '\n\nTo answer by email, reply to the question\'s own email thread.';
}

function emailHelpText_() {
  return [
    'Claude Assistant by email',
    '• Answer: tap a button in a question email, or reply to that email with ' + '"1", "allow", "deny <reason>" or any text.',
    '• Commands: send yourself an email with subject "claude sessions", "claude status", "claude pending" or "claude help".',
    'Answers only ever go to an existing pending question; nothing here runs commands on your PC.',
  ].join('\n');
}

// ---- answer page (served by the ANSWER_URL deployment: "Anyone within <your domain>") ----

function pageShell_(title, body) {
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    'body{margin:0;background:#f1f3f4;font-family:Roboto,Arial,Helvetica,sans-serif;color:#202124}' +
    '.card{max-width:560px;margin:24px auto;background:#fff;border:1px solid #dadce0;border-radius:12px;overflow:hidden}' +
    '.top{background:#1a73e8;color:#fff;padding:16px 22px}.top h2{margin:4px 0 0;font-size:19px}.chips{font-size:12px;opacity:.95;margin-top:6px}' +
    '.in{padding:20px 22px;font-size:15px;line-height:1.5}pre{background:#202124;color:#e8eaed;padding:12px 14px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font:13px/1.5 Menlo,Consolas,monospace}' +
    '.q{white-space:pre-wrap;background:#f8f9fa;border-left:4px solid #1a73e8;padding:10px 14px;border-radius:0 8px 8px 0}' +
    '.answer{margin:16px 0;padding:12px 14px;background:#e8f0fe;border-radius:8px}' +
    'button{background:#1a73e8;color:#fff;border:0;border-radius:22px;padding:12px 26px;font-size:16px;font-weight:bold;width:100%}' +
    'textarea,input[type=text],input:not([type]){width:100%;box-sizing:border-box;font-size:15px;padding:10px;border:1px solid #dadce0;border-radius:8px}textarea{min-height:110px}' +
    'fieldset{border:1px solid #dadce0;border-radius:8px;margin:12px 0}.muted{color:#5f6368;font-size:13px}.warn{color:#d93025;background:#fce8e6;padding:10px 12px;border-radius:8px}' +
    '#out{font-weight:bold;margin-top:14px;text-align:center}</style></head><body><div class="card">' + body + '</div></body></html>';
  return HtmlService.createHtmlOutput(htmlSafe_(html)).setTitle(title);
}

function answerPage_(p) {
  var c = cfg_();
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email || c.allowed.indexOf(email) < 0) {
    return pageShell_('Not allowed', '<div class="in"><h2>⛔ Not allowed</h2><p>Open this link while signed in to Google with an allowed account. ' +
      'If you are signed in, ANSWER_URL must point to a web-app deployment with access “Anyone within your domain”.</p></div>');
  }
  var rec = getRec_(p.q);
  if (!rec || rec.q.sessionId !== p.s || !safeEqual_(answerToken_(p.q, p.a, p.i), String(p.t || ''))) {
    return pageShell_('Invalid link', '<div class="in"><h2>Invalid or outdated link</h2></div>');
  }
  var q = rec.q;
  var head = '<div class="top"><div class="chips">' + esc_(q.project) + ' · ' + esc_(q.sessionId) + ' · ' + esc_(q.id) + '</div><h2>' + esc_(q.title) + '</h2></div><div class="in">' +
    (q.kind === 'permission' && q.permission ? '<div class="muted">' + esc_(q.permission.tool) + '</div><pre>' + esc_(q.permission.summary) + '</pre>' : '<div class="q">' + esc_(String(q.text).slice(0, 3000)) + '</div>');
  if (rec.status !== 'PENDING') return pageShell_('Already handled', head + '<div class="answer"><b>' + esc_(STATUS_TEXT[rec.status] || rec.status) + '</b>' + (rec.answerSummary ? ': ' + esc_(rec.answerSummary) : '') + '</div></div>');

  var choice = answerChoices_(rec).filter(function (ch) { return ch.act === p.a && String(ch.i === undefined ? '' : ch.i) === String(p.i === undefined ? '' : p.i); })[0];
  if (!choice) return pageShell_('Invalid link', '<div class="in"><h2>Invalid link</h2></div>');
  var fields = '';
  if (p.a === 'text') fields = '<p><textarea id="text" placeholder="Your answer"></textarea></p>';
  if (p.a === 'deny') fields = '<p><textarea id="text" placeholder="Reason (optional, Claude will see it)"></textarea></p>';
  if (p.a === 'allow' && q.permission && q.permission.dangerous) {
    fields = '<p class="warn"><b>⚠️ Sensitive operation:</b> ' + esc_((q.permission.reasons || []).join(', ')) + '</p><p><label><input type="checkbox" id="confirm"> I understand and want to allow this</label></p>';
  }
  if (p.a === 'form') {
    fields = (q.questions || []).map(function (x, i) {
      var type = x.multiSelect ? 'checkbox' : 'radio';
      return '<fieldset style="margin:10px 0"><legend><b>' + esc_(x.question) + '</b></legend>' +
        (x.options || []).map(function (o) { return '<label style="display:block;margin:4px 0"><input type="' + type + '" name="q' + i + '" value="' + esc_(o.label) + '"> ' + esc_(o.label) + '</label>'; }).join('') +
        '<input id="q' + i + '_other" placeholder="Or type your own answer" style="width:100%;margin-top:4px"></fieldset>';
    }).join('');
  }
  var data = JSON.stringify({ q: p.q, s: p.s, a: p.a, i: p.i === undefined ? null : p.i, t: p.t, n: (q.questions || []).length });
  var script = '<script>var D=' + data.replace(/</g, '\\u003c') + ';' +
    'function send(){var b=document.getElementById("go");b.disabled=true;b.textContent="Sending…";' +
    'var t=document.getElementById("text");D.text=t?t.value:"";var c=document.getElementById("confirm");D.confirm=c?c.checked:false;' +
    'if(D.a==="form"){D.answers=[];for(var k=0;k<D.n;k++){var picked=[].slice.call(document.querySelectorAll("input[name=q"+k+"]:checked")).map(function(e){return e.value});' +
    'D.answers.push({picked:picked,other:document.getElementById("q"+k+"_other").value});}}' +
    'google.script.run.withSuccessHandler(function(m){document.getElementById("out").textContent=m;b.style.display="none";})' +
    '.withFailureHandler(function(e){document.getElementById("out").textContent="Error: "+e.message;b.disabled=false;b.textContent="Confirm";}).answerFromPage(D);}</script>';
  return pageShell_('Claude Assistant', head + '<div class="answer">Your answer: <b>' + esc_(choice.label) + '</b></div>' + fields +
    '<button id="go" onclick="send()">Confirm</button><div id="out"></div><p class="muted">Only this pending question is answered. Nothing else runs on your PC.</p></div>' + script);
}

/** Called from the answer page (google.script.run). Re-checks identity, token and state. */
function answerFromPage(d) {
  var c = cfg_();
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email || c.allowed.indexOf(email) < 0) throw new Error('not allowed');
  d = d || {};
  var i = d.i === null || d.i === undefined || d.i === '' ? undefined : d.i;
  if (!safeEqual_(answerToken_(d.q, d.a, i), String(d.t || ''))) throw new Error('invalid link');
  var rec = getRec_(d.q);
  if (!rec || rec.q.sessionId !== d.s) throw new Error('unknown question');
  var ev = { addon: false, user: { email: email } };
  var r;
  switch (d.a) {
    case 'opt': r = record_(ev, rec.q.id, 'option', { index: Number(i) }); break;
    case 'text':
      if (!String(d.text || '').trim()) return 'Nothing sent: the answer was empty.';
      r = record_(ev, rec.q.id, 'text', { text: String(d.text).trim() }); break;
    case 'allow':
      if (rec.q.permission && rec.q.permission.dangerous && d.confirm !== true) return 'Tick the confirmation box to allow this sensitive operation.';
      r = record_(ev, rec.q.id, 'allow', { confirmed: true }); break;
    case 'allowSession': r = record_(ev, rec.q.id, 'allow_session', {}); break;
    case 'deny': r = record_(ev, rec.q.id, 'deny', { message: String(d.text || '').trim() }); break;
    case 'cancel': r = record_(ev, rec.q.id, 'cancel', {}); break;
    case 'form': {
      var answers = {};
      var missing = [];
      (rec.q.questions || []).forEach(function (x, k) {
        var a = (d.answers || [])[k] || {};
        var other = String(a.other || '').trim();
        var picked = (a.picked || []).map(String);
        var v = other ? (x.multiSelect ? picked.concat([other]) : other) : x.multiSelect ? picked : picked[0];
        if (!v || (Array.isArray(v) && !v.length)) missing.push(x.question);
        answers[x.question] = v;
      });
      if (missing.length) return 'Not sent — please answer: ' + missing.join('; ');
      r = record_(ev, rec.q.id, 'answers', { answers: answers });
      break;
    }
    default: throw new Error('invalid action');
  }
  return r.lastError ? '⚠️ ' + r.lastError : '✅ Sent to ' + rec.q.sessionId + ': ' + r.answerSummary + '. You can close this page.';
}

// =====================================================================================
// Manual test: run from the Apps Script editor (select "testEmail" → Run).
// The first run asks for Gmail permission; afterwards you receive a sample question email
// rendered exactly like a real one (buttons appear when ANSWER_URL is set).
// =====================================================================================

function testEmail() {
  var c = cfg_();
  var now = Date.now();
  var rec = {
    status: 'PENDING',
    q: {
      id: 'qtest1',
      sessionId: 'session_000',
      project: 'Test project',
      kind: 'ask_user_question',
      title: 'Claude needs your input',
      text: 'This is a test email from Claude Assistant. Which option looks right?',
      options: [
        { label: 'Looks good', description: 'The email renders correctly' },
        { label: 'Something is off', description: 'Layout or characters look wrong' },
      ],
      questions: [{ question: 'This is a test email from Claude Assistant. Which option looks right?', header: 'Test', multiSelect: false, options: [] }],
      allowText: true,
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
    },
  };
  var to = notifyAddress_(c);
  MailApp.sendEmail({ to: to, subject: subjectSafe_('[Claude · Test project] ❓ Question: test email'), body: plain_(emailText_(rec)), htmlBody: htmlSafe_(emailHtml_(c, rec)), name: 'Claude Assistant' });
  console.log('Test email sent to ' + to + ' (this is only a preview; replying to it does nothing).');
}
