// Shared helpers for response adapters. Every adapter returns either
//   { ok: true, ... }   or   { ok: false, reason }
// and never throws for user-supplied input.

export const MAX_TEXT_ANSWER = 4000;

export function reject(reason) {
  return { ok: false, reason };
}

export function cleanText(value) {
  if (typeof value !== 'string') return null;
  // Strip control characters except newline/tab so nothing can smuggle escape sequences into a PTY.
  const t = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/g, '').trim();
  if (!t) return null;
  return t.length > MAX_TEXT_ANSWER ? null : t;
}

export function optionAt(options, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= (options?.length ?? 0)) return null;
  return { index: i, option: options[i] };
}
