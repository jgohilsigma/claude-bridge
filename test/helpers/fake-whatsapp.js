// A stand-in for the Baileys library: same socket events and sendMessage contract, no network.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const MY_NUMBER = '919000000001';
export const MY_JID = `${MY_NUMBER}@s.whatsapp.net`;
export const MY_LID = '777000111@lid';

export function createFakeWhatsApp() {
  const sent = []; // { jid, content, key, quoted }
  const groups = []; // { jid, subject, participants }
  const blocked = new Set(); // numbers whose privacy settings refuse being added to groups
  const lids = new Map(); // phone → LID: such members are reported (and write) by LID, like newer WhatsApp
  let seq = 0;
  let sock = null;
  const fake = {
    sent,
    groups,
    blocked,
    lids,
    get sock() {
      return sock;
    },
    loader: async () => ({
      useMultiFileAuthState: async (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        return { state: {}, saveCreds() {} };
      },
      makeWASocket: () => {
        const ev = new EventEmitter();
        sock = {
          ev,
          user: { id: `${MY_NUMBER}:7@s.whatsapp.net`, lid: '777000111:7@lid', name: 'Jay' },
          async sendMessage(jid, content, opts) {
            const key = { remoteJid: jid, fromMe: true, id: `BOT${++seq}` };
            sent.push({ jid, content, key, quoted: opts?.quoted || null });
            // WhatsApp echoes messages you send into your own chat back as upserts.
            if (content.text && !content.edit) setImmediate(() => ev.emit('messages.upsert', { type: 'notify', messages: [{ key, message: { conversation: content.text }, messageTimestamp: Math.floor(Date.now() / 1000) }] }));
            return { key };
          },
          async groupCreate(subject, participants) {
            const jid = `1203630${++seq}@g.us`;
            const added = participants.filter((p) => !blocked.has(p.split('@')[0]));
            groups.push({ jid, subject, participants: added });
            const asMember = (p) => (lids.has(p.split('@')[0]) ? { id: lids.get(p.split('@')[0]), phoneNumber: p } : { id: p });
            return { id: jid, subject, participants: [{ id: MY_JID, admin: 'superadmin' }, ...added.map(asMember)] };
          },
          async groupInviteCode() {
            return 'INVITE123';
          },
          end() {},
          async logout() {},
        };
        setImmediate(() => ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
      DisconnectReason: { loggedOut: 401 },
      Browsers: { macOS: (n) => ['Mac OS', n, '14'] },
      jidNormalizedUser: (j) => (j ? j.replace(/:\d+@/, '@') : j),
      isJidGroup: (j) => j.endsWith('@g.us'),
      isJidBroadcast: (j) => j.endsWith('@broadcast'),
      logger: {},
    }),
    /** You typing in WhatsApp. `quote` = the bot message key you replied to. */
    userSays(text, { quote = null, chat = MY_JID, fromMe = true, ageSec = 0, participant } = {}) {
      const id = `USER${++seq}`;
      const message = quote ? { extendedTextMessage: { text, contextInfo: { stanzaId: quote.id } } } : { conversation: text };
      sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) }, message, messageTimestamp: Math.floor(Date.now() / 1000) - ageSec }] });
      return id;
    },
    texts: () => sent.filter((x) => x.content.text && !x.content.edit).map((x) => x.content.text),
    edits: () => sent.filter((x) => x.content.edit).map((x) => ({ id: x.content.edit.id, text: x.content.text })),
    reactions: () => sent.filter((x) => x.content.react).map((x) => ({ id: x.content.react.key.id, emoji: x.content.react.text })),
  };
  return fake;
}

export function linkedHome(home) {
  fs.mkdirSync(path.join(home, 'whatsapp-auth'), { recursive: true });
  fs.writeFileSync(path.join(home, 'whatsapp-auth', 'creds.json'), '{}');
  return home;
}
