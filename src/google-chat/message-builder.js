// Builds the payloads sent to Apps Script. Cards themselves are rendered in Apps Script (it also
// needs them for /pending), so this module defines the data contract.
import { truncate } from '../util/ids.js';

export function questionForChat(q, session) {
  const p = q.payload || {};
  return {
    id: q.id,
    sessionId: q.session_id,
    project: session?.project_name || '',
    cwd: session?.cwd || '',
    kind: q.kind,
    eventType: q.event_type,
    title: q.title,
    text: truncate(q.question, 3000),
    options: (q.options || []).slice(0, 12).map((o) => ({ label: truncate(o.label, 120), description: truncate(o.description || '', 200) })),
    questions: q.kind === 'ask_user_question' ? (p.questions || []).map((x) => ({ question: x.question, header: x.header, multiSelect: !!x.multiSelect, options: (x.options || []).map((o) => ({ label: o.label, description: truncate(o.description || '', 200) })) })) : [],
    permission: q.kind === 'permission'
      ? { tool: p.toolName, summary: truncate(p.summary, 1500), detail: truncate(p.detail, 2000), dangerous: !!p.dangerous, reasons: p.dangerReasons || [], allowSession: !!p.allowSession }
      : null,
    allowText: !!p.allowText,
    context: p.context
      ? { task: truncate(p.context.task || '', 600), actions: (p.context.actions || []).slice(0, 12), lastMessage: q.kind === 'free_text' ? '' : truncate(p.context.lastMessage || '', 1200) }
      : null,
    createdAt: q.created_at,
    expiresAt: q.expires_at,
    status: q.status,
  };
}

export function statusForChat(q) {
  const answer = q.answer && typeof q.answer === 'object' ? q.answer : null;
  return { id: q.id, status: q.status, note: q.resolution_note || '', answerSummary: answer?.summary || '', answeredBy: answer?.user || '' };
}

export function sessionsForChat(sessions, questions) {
  const open = new Map();
  for (const q of questions) open.set(q.session_id, (open.get(q.session_id) || 0) + 1);
  return sessions.map((s) => ({
    id: s.id,
    project: s.project_name,
    status: displayStatus(s, open.get(s.id) || 0),
    pending: open.get(s.id) || 0,
    pid: s.process_id,
    startedAt: s.started_at,
    lastActivityAt: s.last_activity_at,
    endedAt: s.ended_at,
  }));
}

export function displayStatus(s, openCount) {
  if (['COMPLETED', 'FAILED', 'STOPPED'].includes(s.status)) return s.status;
  if (openCount > 0) return 'WAITING';
  if (s.waiting_prompt) return 'IDLE';
  return s.status === 'STARTING' ? 'STARTING' : 'RUNNING';
}
