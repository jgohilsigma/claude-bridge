// Minimal Google Apps Script runtime for running apps-script/Code.gs under Node in tests.
// Implements only the services Code.gs uses, with Apps Script semantics where they matter
// (signed Java byte arrays from Utilities, blocking Utilities.sleep, script lock, cache TTLs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const toSignedBytes = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const fromBytes = (v) => (Array.isArray(v) ? Buffer.from(v.map((b) => (b + 256) % 256)) : Buffer.from(String(v), 'utf8'));

export function createGasRuntime({ codePath, props = {}, activeUserEmail = '', ownerEmail = 'owner@example.com', fetchHandler }) {
  const store = { props: { ...props }, cache: new Map(), pushes: [], sheets: new Map(), triggers: [], fetches: [] };
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in store.props ? store.props[k] : null),
      getProperties: () => ({ ...store.props }),
      setProperty: (k, v) => {
        if (String(v).length > 9216) throw new Error(`Argument too large: value for ${k}`);
        store.props[k] = String(v);
      },
      setProperties: (o) => Object.entries(o).forEach(([k, v]) => (store.props[k] = String(v))),
      deleteProperty: (k) => delete store.props[k],
    }),
  };

  const cache = {
    get: (k) => {
      const e = store.cache.get(k);
      if (!e) return null;
      if (e.exp < Date.now()) {
        store.cache.delete(k);
        return null;
      }
      return e.v;
    },
    put: (k, v, ttl = 600) => store.cache.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }),
    remove: (k) => store.cache.delete(k),
  };

  const Utilities = {
    Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeHmacSha256Signature: (value, key) => toSignedBytes(crypto.createHmac('sha256', Buffer.from(String(key), 'utf8')).update(String(value), 'utf8').digest()),
    computeDigest: (alg, value) => toSignedBytes(crypto.createHash(alg).update(String(value)).digest()),
    computeRsaSha256Signature: (value, key) => toSignedBytes(crypto.sign('sha256', Buffer.from(String(value)), key)),
    base64EncodeWebSafe: (v) => fromBytes(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    getUuid: () => crypto.randomUUID(),
    sleep: (ms) => Atomics.wait(sleepBuf, 0, 0, ms),
    formatDate: (d) => d.toISOString().slice(11, 16),
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (content) => ({ content, setMimeType() { return this; } }),
  };

  const makeSheet = (name) => {
    const rows = [];
    const sh = {
      name,
      rows,
      appendRow: (r) => rows.push(r.map((x) => (x instanceof Date ? x.toISOString() : x))),
      getRange: (a, col) => {
        if (typeof a === 'string') {
          return {
            createTextFinder: (text) => ({
              matchEntireCell: () => ({
                findNext: () => {
                  const i = rows.findIndex((r) => String(r[0]) === String(text));
                  return i < 0 ? null : { getRow: () => i + 1 };
                },
              }),
            }),
          };
        }
        return { setValue: (v) => (rows[a - 1][col - 1] = v instanceof Date ? v.toISOString() : v) };
      },
      setName: (n) => {
        store.sheets.delete(sh.name);
        sh.name = n;
        store.sheets.set(n, sh);
      },
    };
    store.sheets.set(name, sh);
    return sh;
  };
  const ss = {
    getId: () => 'sheet-1',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-1',
    getName: () => 'Claude Assistant — bridge history',
    getSheetByName: (n) => store.sheets.get(n) || null,
    insertSheet: (n) => makeSheet(n),
    getSheets: () => [...store.sheets.values()],
  };
  const SpreadsheetApp = {
    create: () => {
      makeSheet('Sheet1');
      return ss;
    },
    openById: (id) => {
      if (id !== 'sheet-1') throw new Error('not found');
      return ss;
    },
  };

  const UrlFetchApp = {
    fetch: (url, opts = {}) => {
      store.fetches.push({ url, opts });
      const r = fetchHandler ? fetchHandler(url, opts, store) : { code: 200, body: '{}' };
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    },
  };

  // ---- Gmail (enough of GmailApp for Code.gs; messages from the owner count as "in:sent") ----
  const gmail = { threads: new Map(), seq: 0, labels: new Set() };
  store.gmail = gmail;
  const owner = () => store.ownerEmail;
  const msgApi = (m) => ({
    getId: () => m.id,
    getThread: () => threadApi(gmail.threads.get(m.threadId)),
    getHeader: (h) => (h === 'Message-ID' ? `<${m.rfcId}>` : ''),
    getFrom: () => m.from,
    getPlainBody: () => m.plain,
    getSubject: () => m.subject,
  });
  const threadApi = (t) => ({
    getId: () => t.id,
    getMessages: () => t.messages.map(msgApi),
    reply: (body, opts = {}) => {
      addMessage(t, { from: `Owner <${owner()}>`, plain: body, html: opts.htmlBody, sent: true, subject: 'Re: ' + t.messages[0].subject });
      return threadApi(t);
    },
    addLabel: (l) => t.labels.push(l.name),
    markRead: () => (t.read = true),
  });
  const addMessage = (t, m) => {
    const msg = { id: 'm' + ++gmail.seq, rfcId: `rfc${gmail.seq}@mail`, threadId: t.id, date: Date.now(), ...m };
    t.messages.push(msg);
    return msg;
  };
  const newThread = (to, subject, body, opts = {}) => {
    const t = { id: 't' + ++gmail.seq, messages: [], labels: [], read: false, to };
    gmail.threads.set(t.id, t);
    return addMessage(t, { from: `${opts.name || 'Owner'} <${owner()}>`, subject, plain: body, html: opts.htmlBody, sent: true });
  };
  store.gmailInject = ({ threadId, body, from, sent, subject }) => {
    if (threadId) return addMessage(gmail.threads.get(threadId), { from, plain: body, sent: !!sent, subject: 'Re: x' }).id;
    return newThread(owner(), subject, body).threadId;
  };
  const GmailApp = {
    sendEmail: (to, subject, body, opts) => void newThread(to, subject, body, opts),
    createDraft: (to, subject, body, opts) => ({ send: () => msgApi(newThread(to, subject, body, opts)) }),
    getThreadById: (id) => (gmail.threads.has(id) ? threadApi(gmail.threads.get(id)) : null),
    search: (query, start = 0, max = 100) => {
      gmail.calls = (gmail.calls || 0) + 1;
      const all = [...gmail.threads.values()];
      let m = /rfc822msgid:(\S+)/.exec(query);
      if (m) return all.filter((t) => t.messages.some((x) => x.sent && x.rfcId === m[1])).map(threadApi);
      const after = Number((/after:(\d+)/.exec(query) || [])[1] || 0) * 1000;
      const sentOnly = /in:sent/.test(query);
      const quoted = /subject:"([^"]+)"/.exec(query);
      const word = !quoted && /subject:(\S+)/.exec(query);
      return all
        .filter((t) => (quoted ? t.messages[0].subject.includes(quoted[1]) : word ? t.messages[0].subject.toLowerCase().includes(word[1].toLowerCase()) : true))
        .filter((t) => t.messages.some((x) => (!sentOnly || x.sent) && x.date >= after))
        .slice(start, start + max)
        .map(threadApi);
    },
    getUserLabelByName: (n) => (gmail.labels.has(n) ? { name: n } : null),
    createLabel: (n) => {
      gmail.labels.add(n);
      return { name: n };
    },
  };
  const MailApp = {
    sendEmail: (o) => {
      store.mailSent = (store.mailSent || 0) + 1;
      newThread(o.to, o.subject, o.body, { htmlBody: o.htmlBody, name: o.name });
    },
    getRemainingDailyQuota: () => 1500 - (store.mailSent || 0),
  };
  const HtmlService = { createHtmlOutput: (html) => ({ content: html, setTitle() { return this; } }) };

  const context = {
    GmailApp,
    MailApp,
    HtmlService,
    PropertiesService,
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    Utilities,
    ContentService,
    SpreadsheetApp,
    UrlFetchApp,
    Session: { getActiveUser: () => ({ getEmail: () => store.activeUserEmail }), getEffectiveUser: () => ({ getEmail: () => store.ownerEmail }), getScriptTimeZone: () => 'UTC' },
    ScriptApp: {
      getProjectTriggers: () => store.triggers,
      deleteTrigger: (t) => store.triggers.splice(store.triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (m) => ({ create: () => store.triggers.push({ fn, m, getHandlerFunction: () => fn }) }) }) }),
    },
    console: { log() {}, warn() {}, error: (...a) => process.env.GAS_DEBUG && console.error('[gas]', ...a), info() {} },
    JSON,
    Date,
    Math,
  };
  store.activeUserEmail = activeUserEmail;
  store.ownerEmail = ownerEmail;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });
  return { context, store };
}
