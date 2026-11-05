import crypto from 'node:crypto';

// Question IDs are short so they can be typed on a phone (`/reply q7k2m 1`).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i ambiguity

export function shortId(prefix = 'q', len = 5) {
  const bytes = crypto.randomBytes(len);
  let s = prefix;
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export const uuid = () => crypto.randomUUID();

export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncate(s, max) {
  s = String(s ?? '');
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}
