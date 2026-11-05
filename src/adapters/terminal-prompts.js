// Adapters for prompts detected on the terminal screen (PTY): numbered or cursor menus,
// yes/no confirmations and generic free-text prompts. They produce keystroke plans that the
// session runner only injects after re-verifying the same prompt is still on screen.
import { cleanText, optionAt, reject } from './common.js';

export const KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r' };

export function arrowPlan(fromIndex, toIndex) {
  const delta = toIndex - fromIndex;
  return [...Array(Math.abs(delta)).fill(delta > 0 ? KEYS.down : KEYS.up), KEYS.enter];
}

export function menuKeys(question, response) {
  const { cursorIndex = 0 } = question.payload;
  if (response.type === 'cancel') return { ok: true, keys: null, summary: 'dismissed (left for the terminal)' };
  if (response.type !== 'option') return reject('menus only accept an option');
  const hit = optionAt(question.options, response.value?.index);
  if (!hit) return reject('option index out of range');
  // The runner recomputes arrow presses from the cursor position on screen at injection time.
  return { ok: true, select: hit.index, keys: arrowPlan(cursorIndex, hit.index), summary: hit.option.label };
}

export function yesNoKeys(question, response) {
  if (response.type === 'cancel') return { ok: true, keys: null, summary: 'dismissed (left for the terminal)' };
  if (response.type !== 'option') return reject('yes/no prompts only accept Yes or No');
  const hit = optionAt(question.options, response.value?.index);
  if (!hit) return reject('option index out of range');
  return { ok: true, keys: [hit.index === 0 ? 'y' : 'n', KEYS.enter], summary: hit.index === 0 ? 'yes' : 'no' };
}

export function textPromptKeys(question, response) {
  if (response.type === 'cancel') return { ok: true, keys: null, summary: 'dismissed (left for the terminal)' };
  if (response.type !== 'text') return reject('this prompt needs a text answer');
  const t = cleanText(response.value?.text);
  if (!t || t.includes('\n')) return reject('answer must be a single non-empty line');
  return { ok: true, keys: [t, KEYS.enter], summary: t };
}
