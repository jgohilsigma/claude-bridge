// Request authentication between the local bridge and the Apps Script web app, plus the
// Google Chat user allowlist and the loopback IPC token.
//
// Apps Script's doPost() cannot read request headers, so the signature travels in the body:
//   { v: 1, ts, nonce, op, payload: "<json string>", sig: hex(HMAC_SHA256(secret, `${ts}.${nonce}.${op}.${payload}`)) }
// The same scheme is used in both directions (Apps Script signs its responses too).
import crypto from 'node:crypto';

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const hmacHex = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function signEnvelope(secret, op, payloadObj, { now = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const payload = JSON.stringify(payloadObj ?? {});
  const ts = now;
  return { v: 1, ts, nonce, op, payload, sig: hmacHex(secret, `${ts}.${nonce}.${op}.${payload}`) };
}

/**
 * Verifies an envelope. `seenNonce(nonce)` must return true if the nonce was already used
 * (replay) and record it otherwise.
 */
export function verifyEnvelope(secret, env, { now = Date.now(), seenNonce = () => false } = {}) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'malformed envelope' };
  const { ts, nonce, op, payload, sig } = env;
  if (typeof ts !== 'number' || typeof nonce !== 'string' || typeof op !== 'string' || typeof payload !== 'string' || typeof sig !== 'string') {
    return { ok: false, error: 'malformed envelope' };
  }
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return { ok: false, error: 'stale or future timestamp' };
  if (!timingSafeEqualHex(hmacHex(secret, `${ts}.${nonce}.${op}.${payload}`), sig)) return { ok: false, error: 'bad signature' };
  if (seenNonce(nonce)) return { ok: false, error: 'replayed nonce' };
  try {
    return { ok: true, op, payload: JSON.parse(payload) };
  } catch {
    return { ok: false, error: 'payload is not JSON' };
  }
}

/** In-memory replay cache with TTL (used for responses coming back from Apps Script). */
export function createNonceCache(ttlMs = MAX_CLOCK_SKEW_MS * 2) {
  const seen = new Map();
  return (nonce) => {
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(nonce)) return true;
    seen.set(nonce, now + ttlMs);
    return false;
  };
}

export function isAllowedUser(allowedEmails, email) {
  if (!email || !Array.isArray(allowedEmails) || allowedEmails.length === 0) return false;
  return allowedEmails.includes(String(email).trim().toLowerCase());
}

export const generateSecret = () => crypto.randomBytes(32).toString('base64url');

export function checkBearer(req, token) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  return !!m && timingSafeEqualHex(m[1], token);
}
