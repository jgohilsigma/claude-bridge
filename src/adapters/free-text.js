// Adapter for "Claude finished its turn and is waiting at the prompt" (Stop hook).
// The answer is typed into Claude's input box through the PTY, but only after the daemon
// verified the session is still idle at the prompt (Stop seen, no UserPromptSubmit since).
import { cleanText, optionAt, reject } from './common.js';
import { truncate } from '../util/ids.js';

const NUMBERED = /^\s*(?:[-*]\s*)?(?:\*\*)?(\d{1,2})[.)](?:\*\*)?\s+(.+?)\s*$/;
const YES_NO_LEAD = /^(should|shall|do you|would you|want me|can i|may i|is it ok|are you ok|proceed|continue)/i;

const stripMd = (s) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** Finds a trailing numbered list of choices or a yes/no question in Claude's last message. */
export function detectChoices(message) {
  const lines = String(message || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  // Walk backwards to the last numbered block that sits near the end of the message.
  let blockEnd = -1;
  for (let i = end; i >= 0 && i >= end - 6; i--) {
    if (NUMBERED.test(lines[i])) {
      blockEnd = i;
      break;
    }
  }
  if (blockEnd >= 0) {
    const items = [];
    for (let i = blockEnd; i >= 0; i--) {
      const m = NUMBERED.exec(lines[i]);
      if (m) items.unshift({ n: Number(m[1]), label: stripMd(m[2]) });
      else if (lines[i].trim() === '' || /^\s{2,}\S/.test(lines[i])) continue; // blank or wrapped continuation
      else break;
    }
    const sequential = items.length >= 2 && items.every((it, idx) => it.n === idx + 1);
    if (sequential && items.length <= 9) return { type: 'numbered', options: items.map((it) => ({ label: truncate(it.label, 120), send: it.label })) };
  }
  const tail = lines.slice(Math.max(0, end - 2), end + 1).join(' ');
  const lastSentence = (tail.match(/[^.!?\n]*\?\s*$/) || [''])[0].trim();
  if (lastSentence && YES_NO_LEAD.test(lastSentence)) {
    return { type: 'yes_no', options: [{ label: 'Yes', send: 'Yes' }, { label: 'No', send: 'No' }] };
  }
  return { type: 'none', options: [] };
}

export function buildTurnFinished(event) {
  const msg = String(event.last_assistant_message || '').trim();
  const choices = detectChoices(msg);
  return {
    kind: 'free_text',
    eventType: 'Stop',
    // A turn that ends without a question to you is a finished task.
    title: choices.options.length || /\?\s*$/.test(msg) ? 'Claude is asking you something' : '✅ Task finished',
    question: truncate(msg || '(no message)', 2500),
    options: choices.options.map((o) => ({ label: o.label, description: '' })),
    payload: { choices: choices.options, allowText: true, blocking: false },
  };
}

export function freeTextInjection(question, response) {
  switch (response.type) {
    case 'option': {
      const hit = optionAt(question.payload.choices, response.value?.index);
      if (!hit) return reject('option index out of range');
      return { ok: true, text: hit.option.send, summary: hit.option.label };
    }
    case 'text': {
      const t = cleanText(response.value?.text);
      if (!t) return reject('empty or oversized text answer');
      return { ok: true, text: t, summary: truncate(t, 80) };
    }
    case 'cancel':
      return { ok: true, text: null, summary: 'dismissed' };
    default:
      return reject(`response type "${response.type}" is not valid here`);
  }
}
