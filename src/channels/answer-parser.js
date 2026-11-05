// Turns a typed chat reply ("1", "allow", "deny not now", "1,3", free text…) into a response the
// ResponseRouter understands. Shared by every chat platform (WhatsApp now, Telegram later).
const NUM = /^\s*(\d{1,2})\s*$/;

function pickOptions(text, options) {
  const parts = String(text).split(/[\s,;]+/).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^\d{1,2}$/.test(p))) return null;
  const idx = parts.map((p) => Number(p) - 1);
  if (idx.some((i) => i < 0 || i >= options.length)) return { error: `Pick numbers between 1 and ${options.length}.` };
  return { labels: idx.map((i) => options[i].label) };
}

/** @returns {{type: string, value: object} | {error: string}} */
export function parseAnswerText(q, raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'Empty answer.' };
  if (/^(dismiss|cancel|skip)$/i.test(text)) return { type: 'cancel', value: {} };
  const p = q.payload || {};

  if (q.kind === 'permission') {
    const [word, ...rest] = text.split(/\s+/);
    const w = word.toLowerCase();
    const tail = rest.join(' ').trim();
    if (['allow', 'yes', 'y', 'approve', 'ok'].includes(w)) {
      if (p.dangerous && tail.toLowerCase() !== 'confirm') return { error: '⚠️ Sensitive operation. To approve, reply *allow confirm*.' };
      return { type: 'allow', value: { confirmed: true } };
    }
    if (w === 'session') {
      if (!p.allowSession) return { error: '"session" is not available for this request. Reply *allow* or *deny*.' };
      return { type: 'allow_session', value: {} };
    }
    if (['deny', 'no', 'n', 'reject'].includes(w)) return { type: 'deny', value: { message: tail } };
    return { error: `Reply *allow*${p.allowSession ? ', *session*' : ''} or *deny <reason>*.` };
  }

  if (q.kind === 'ask_user_question') {
    const questions = p.questions || [];
    if (questions.length > 1) {
      // One line per question, in order: a number, several numbers ("1,3"), or your own text.
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (/^\d+\s*[).:-]\s+\S/.test(l) ? l.replace(/^\d+\s*[).:-]\s+/, '') : l));
      if (lines.length !== questions.length) return { error: `This has ${questions.length} questions — reply with ${questions.length} lines, one answer per line.` };
      const answers = {};
      for (let i = 0; i < questions.length; i++) {
        const pick = pickOptions(lines[i], questions[i].options || []);
        if (pick?.error) return pick;
        if (pick && !questions[i].multiSelect && pick.labels.length > 1) return { error: `Question ${i + 1} accepts one answer.` };
        answers[questions[i].question] = pick ? (questions[i].multiSelect ? pick.labels : pick.labels[0]) : lines[i];
      }
      return { type: 'answers', value: { answers } };
    }
    const only = questions[0];
    if (only?.multiSelect) {
      const pick = pickOptions(text, only.options || []);
      if (pick?.error) return pick;
      return pick ? { type: 'answers', value: { answers: { [only.question]: pick.labels } } } : { type: 'text', value: { text } };
    }
  }

  const m = NUM.exec(text);
  if (m && (q.options || []).length) {
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= q.options.length) return { error: `Pick a number between 1 and ${q.options.length}.` };
    return { type: 'option', value: { index: i } };
  }
  if (q.kind === 'yes_no') {
    if (/^(y|yes)$/i.test(text)) return { type: 'option', value: { index: 0 } };
    if (/^(n|no)$/i.test(text)) return { type: 'option', value: { index: 1 } };
  }
  if (q.kind === 'menu' || q.kind === 'yes_no') return { error: `Reply with a number between 1 and ${(q.options || []).length}.` };
  return { type: 'text', value: { text } };
}
