// WhatsApp "linked device" connection (like WhatsApp Web) using the Baileys library.
// Outbound connection only; the login (keys) is stored in BRIDGE_HOME/whatsapp-auth (mode 700).
//
// States: not_linked → (login) → qr → connected; connected → connecting (network drop, retried);
//         logged_out (unlinked from the phone: run `bridge whatsapp login` again).
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const QR_WINDOW_MS = 3 * 60 * 1000;

async function loadBaileys() {
  const b = await import('@whiskeysockets/baileys');
  const pino = (await import('pino')).default;
  return { ...b, makeWASocket: b.default || b.makeWASocket, logger: pino({ level: 'silent' }) };
}

export class WhatsAppConnection extends EventEmitter {
  /** @param {{ authDir: string, logger: object, loader?: () => Promise<object> }} opts  loader is injectable for tests */
  constructor({ authDir, logger, loader = loadBaileys, caFile = '' }) {
    super();
    this.authDir = authDir;
    this.caFile = caFile;
    this.log = logger;
    this.loader = loader;
    this.state = this.hasCreds() ? 'connecting' : 'not_linked';
    this.qr = null;
    this.me = null;
    this.sock = null;
    this.stopped = true;
    this.retry = 0;
    this.lastError = null;
  }

  hasCreds() {
    return fs.existsSync(path.join(this.authDir, 'creds.json'));
  }

  setState(state, extra = {}) {
    const changed = state !== this.state;
    this.state = state;
    Object.assign(this, extra);
    if (changed) {
      this.log.info('whatsapp state', { state, me: this.me?.number || null });
      this.emit('state', state);
    }
  }

  status() {
    return { state: this.state, qr: this.state === 'qr' ? this.qr : null, me: this.me, lastError: this.lastError };
  }

  /** Connects with saved credentials, or (allowQr) starts a new link and exposes the QR code. */
  async start({ allowQr = false } = {}) {
    if (!allowQr && !this.hasCreds()) {
      this.setState('not_linked');
      return;
    }
    this.stopped = false;
    this.qrDeadline = allowQr ? Date.now() + QR_WINDOW_MS : 0;
    await this.connect();
  }

  async connect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const b = await this.loader();
    fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authDir);
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* old socket already closed */
    }
    // Networks that inspect TLS (e.g. a Sophos firewall) need their CA certificate trusted.
    const agent = this.caFile ? new https.Agent({ ca: [...tls.rootCertificates, fs.readFileSync(this.caFile, 'utf8')] }) : undefined;
    const sock = b.makeWASocket({
      ...(agent ? { agent, fetchAgent: agent } : {}),
      auth: state,
      logger: b.logger,
      browser: b.Browsers?.macOS ? b.Browsers.macOS('Claude Bridge') : undefined,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Groups are not ignored: the channel only accepts its own session groups.
      shouldIgnoreJid: (jid) => b.isJidBroadcast?.(jid) || false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    this.b = b;
    if (this.state !== 'qr') this.setState('connecting');
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onUpdate(sock, u));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages || []) this.emit('message', m, type);
    });
  }

  onUpdate(sock, u) {
    if (sock !== this.sock) return; // stale socket
    if (u.qr) {
      if (!this.qrDeadline || Date.now() > this.qrDeadline) {
        this.log.warn('whatsapp: not linked and no login in progress; stopping');
        this.stop();
        this.setState('not_linked', { qr: null });
        return;
      }
      this.setState('qr', { qr: u.qr });
      this.emit('qr', u.qr);
    }
    if (u.connection === 'open') {
      this.retry = 0;
      this.lastError = null;
      const user = sock.user || {};
      const norm = (j) => (j && this.b?.jidNormalizedUser ? this.b.jidNormalizedUser(j) : j);
      const pn = norm(user.id);
      this.me = { jid: pn, lid: norm(user.lid) || null, number: String(pn || '').split('@')[0], name: user.name || user.notify || '' };
      this.qrDeadline = 0;
      this.setState('connected', { qr: null });
      this.emit('open', this.me);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === (this.b?.DisconnectReason?.loggedOut ?? 401);
      this.lastError = u.lastDisconnect?.error?.message || (code ? `closed (${code})` : 'closed');
      if (/certificate/i.test(this.lastError)) {
        this.lastError += ' — your network inspects HTTPS traffic (company firewall). Run `node bin/bridge.js doctor` for the fix.';
      }
      if (loggedOut) {
        this.log.warn('whatsapp: logged out from the phone; run `bridge whatsapp login` again');
        fs.rmSync(this.authDir, { recursive: true, force: true });
        this.stopped = true;
        this.setState('logged_out', { me: null });
        return;
      }
      if (this.stopped) return;
      if (this.state === 'qr' && this.qrDeadline && Date.now() > this.qrDeadline) {
        this.stopped = true;
        this.setState('not_linked', { qr: null });
        return;
      }
      // 515 "restart required" right after scanning the QR code is normal: reconnect at once.
      const delay = code === 515 ? 200 : Math.min(60000, 2000 * 2 ** Math.min(this.retry++, 5));
      if (this.state !== 'qr') this.setState('connecting');
      this.log.info('whatsapp: reconnecting', { code: code ?? null, inMs: delay });
      this.reconnectTimer = setTimeout(() => this.connect().catch((err) => this.log.error('whatsapp reconnect failed', { error: err.message })), delay);
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  async logout() {
    try {
      await this.sock?.logout?.();
    } catch {
      /* not connected */
    }
    await this.stop();
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.setState('not_linked', { me: null, qr: null });
  }

  ensureConnected() {
    if (this.state !== 'connected' || !this.sock) throw new Error(`WhatsApp is ${this.state}`);
  }

  async sendText(jid, text, { quoted } = {}) {
    this.ensureConnected();
    const msg = await this.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    return msg?.key;
  }

  /** Creates a group; returns { jid, members: [{ id, phoneNumber, lid }] } as WhatsApp reports them. */
  async createGroup(subject, participantJids) {
    this.ensureConnected();
    const meta = await this.sock.groupCreate(subject, participantJids);
    return { jid: meta.id, members: meta.participants || [] };
  }

  async inviteLink(groupJid) {
    this.ensureConnected();
    const code = await this.sock.groupInviteCode(groupJid);
    return code ? `https://chat.whatsapp.com/${code}` : null;
  }

  async editText(jid, key, text) {
    this.ensureConnected();
    await this.sock.sendMessage(jid, { text, edit: key });
  }

  async react(jid, key, emoji) {
    this.ensureConnected();
    await this.sock.sendMessage(jid, { react: { text: emoji, key } });
  }
}
