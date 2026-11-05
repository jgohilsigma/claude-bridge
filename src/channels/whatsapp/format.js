// WhatsApp message texts (WhatsApp markup: *bold*, _italic_, ```monospace```).
// Every message the bridge sends starts with BOT_MARK, an invisible character sequence, so the
// bridge never mistakes its own messages (echoed back in your "Message yourself" chat) for replies.
import { truncate } from '../../util/ids.js';

export const BOT_MARK = '\u2063\u2063'; // invisible separators

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const num = (i) => KEYCAPS[i] || `${i + 1}.`;

const STATUS_LINE = {
  DELIVERED: '✅ Answered',
  ANSWERED: '📨 Answer received — delivering…',
  ANSWERED_LOCALLY: '💻 Answered in the terminal',
  EXPIRED: '⌛ Expired — the terminal shows its own prompt',
  CANCELLED: '🚫 Dismissed',
  FAILED: '❌ Not delivered',
};

/** Converts the most common Markdown in Claude's messages to WhatsApp markup. */
export function mdToWhatsApp(text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^(\s*)[-*] /gm, '$1• ')
    .replace(/`([^`\n]+)`/g, '```$1```')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function header(q, session) {
  const finished = q.kind === 'free_text' && /^✅/.test(q.title || '');
  const icon = finished ? '✅' : { ask_user_question: '❓', permission: q.payload?.dangerous ? '⚠️' : '🔐', free_text: '💬', menu: '🖥️', yes_no: '🖥️', text_prompt: '🖥️' }[q.kind] || '❓';
  const title = String(q.title || 'Claude needs your input').replace(/^✅\s*/, '');
  return `${icon} *${title}*\n📂 *${session?.project_name || q.session_id}* · ${q.session_id} · ${q.id}`;
}

function contextBlock(q) {
  const c = q.payload?.context;
  if (!c) return '';
  const out = [];
  if (c.task) out.push(`📝 *You asked:* ${truncate(c.task.replace(/\s+/g, ' '), 300)}`);
  if (c.actions?.length) out.push(`🔧 *What Claude did:*\n${c.actions.slice(-8).map((a) => `• ${a}`).join('\n')}`);
  if (c.lastMessage && q.kind !== 'free_text') out.push(`💬 *Claude said:* ${truncate(mdToWhatsApp(c.lastMessage), 700)}`);
  return out.join('\n\n');
}

function questionBody(q) {
  const p = q.payload || {};
  switch (q.kind) {
    case 'permission': {
      const lines = [`*${p.toolName === 'ExitPlanMode' ? 'Approve this plan' : p.toolName === 'Bash' ? 'Run this command' : `Use ${p.toolName}`}:*`];
      lines.push(p.toolName === 'ExitPlanMode' ? truncate(mdToWhatsApp(p.detail || p.summary), 1500) : '```' + truncate(p.summary, 1200) + '```');
      if (p.detail && p.toolName !== 'ExitPlanMode') lines.push(`_${truncate(p.detail, 300)}_`);
      if (p.dangerous) lines.push(`⚠️ *Sensitive operation:* ${(p.dangerReasons || []).join(', ')}`);
      return lines.join('\n');
    }
    case 'ask_user_question': {
      const qs = p.questions || [];
      return qs
        .map((x, k) => {
          const head = `${qs.length > 1 ? `*${k + 1})* ` : ''}*${x.question}*${x.multiSelect ? ' _(choose any)_' : ''}`;
          const opts = (x.options || []).map((o, i) => `${num(i)} ${o.label}${o.description ? ` — _${truncate(o.description, 120)}_` : ''}`).join('\n');
          return `${head}\n${opts}`;
        })
        .join('\n\n');
    }
    case 'free_text': {
      const finished = /^✅/.test(q.title || '');
      const lines = [`${finished ? '✅ *Summary:*' : '💬 *Claude:*'}\n${truncate(mdToWhatsApp(q.question), 1800)}`];
      if ((q.options || []).length) lines.push(`*Quick answers:*\n${q.options.map((o, i) => `${num(i)} ${o.label}`).join('\n')}`);
      return lines.join('\n\n');
    }
    default:
      return `\`\`\`${truncate(q.question, 1200)}\`\`\`${(q.options || []).length ? '\n' + q.options.map((o, i) => `${num(i)} ${o.label}`).join('\n') : ''}`;
  }
}

export function replyHelp(q) {
  const p = q.payload || {};
  if (q.kind === 'permission') return `*allow*${p.dangerous ? ' *confirm*' : ''}${p.allowSession && !p.dangerous ? ' · *session*' : ''} · *deny <reason>*`;
  if (q.kind === 'ask_user_question' && (p.questions || []).length > 1) return `one line per question (a number or your own text) · *dismiss*`;
  if (q.kind === 'ask_user_question' && p.questions?.[0]?.multiSelect) return `numbers like *1,3* or your own text · *dismiss*`;
  if (q.kind === 'free_text') return `${(q.options || []).length ? `*1*–*${q.options.length}* or ` : ''}your next instruction · *dismiss*`;
  if ((q.options || []).length) return `*1*–*${q.options.length}*${q.kind === 'ask_user_question' ? ' or your own text' : ''} · *dismiss*`;
  return 'your answer · *dismiss*';
}

export function formatQuestion(q, session, { status } = {}) {
  const parts = [BOT_MARK + header(q, session)];
  const ctx = contextBlock(q);
  if (ctx) parts.push(ctx);
  parts.push(questionBody(q));
  if (status && status !== 'PENDING') {
    const a = q.answer && typeof q.answer === 'object' ? q.answer : null;
    const via = !a?.user ? '' : a.user.startsWith('whatsapp:') ? ' _(via WhatsApp)_' : a.user.startsWith('local:') ? ' _(on the PC)_' : ' _(via email)_';
    parts.push(`*${STATUS_LINE[status] || status}*${a?.summary ? `: ${truncate(a.summary, 120)}` : ''}${via}${q.resolution_note && status !== 'DELIVERED' ? `\n_${truncate(q.resolution_note, 160)}_` : ''}`);
  } else {
    parts.push(`↩️ _Reply to this message with:_ ${replyHelp(q)}`);
  }
  return truncate(parts.join('\n\n'), 3800);
}

export function formatNotification(n) {
  const where = n.project ? `\n📂 *${n.project}*${n.sessionId ? ` · ${n.sessionId}` : ''}` : '';
  return `${BOT_MARK}*${n.title || 'Notification'}*${where}\n${mdToWhatsApp(n.text || '')}`;
}

export function botText(text) {
  return BOT_MARK + text;
}

export function isBotText(text) {
  return String(text || '').startsWith(BOT_MARK);
}
