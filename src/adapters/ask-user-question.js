// Adapter for Claude Code's AskUserQuestion tool, answered through a PreToolUse hook.
// Official contract: return permissionDecision "allow" with updatedInput = original input plus an
// `answers` object keyed by the exact question text. Multi-select answers join labels with ", ".
import { cleanText, optionAt, reject } from './common.js';
import { truncate } from '../util/ids.js';

export function buildAskUserQuestion(event) {
  const input = event.tool_input || {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (!questions.length) return null;
  const single = questions.length === 1 && !questions[0].multiSelect;
  const text = questions
    .map((q, i) => (questions.length > 1 ? `${i + 1}) ` : '') + (q.question || ''))
    .join('\n');
  return {
    kind: 'ask_user_question',
    eventType: 'PreToolUse:AskUserQuestion',
    title: 'Claude needs your input',
    question: text,
    options: single ? (questions[0].options || []).map((o) => ({ label: truncate(o.label, 120), description: truncate(o.description || '', 300) })) : [],
    payload: {
      questions: questions.map((q) => ({
        question: q.question,
        header: q.header || '',
        multiSelect: !!q.multiSelect,
        options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })),
      })),
      toolInput: input,
      allowText: true,
      blocking: true,
    },
  };
}

export function askUserQuestionOutput(question, response) {
  const { questions, toolInput } = question.payload;
  let answers;
  switch (response.type) {
    case 'option': {
      if (questions.length !== 1 || questions[0].multiSelect) return reject('option answers are only valid for a single single-select question');
      const hit = optionAt(questions[0].options, response.value?.index);
      if (!hit) return reject('option index out of range');
      answers = { [questions[0].question]: hit.option.label };
      break;
    }
    case 'text': {
      if (questions.length !== 1) return reject('a single text answer is only valid for one question');
      const t = cleanText(response.value?.text);
      if (!t) return reject('empty or oversized text answer');
      answers = { [questions[0].question]: t };
      break;
    }
    case 'answers': {
      const given = response.value?.answers;
      if (!given || typeof given !== 'object') return reject('missing answers');
      answers = {};
      for (const q of questions) {
        let v = given[q.question];
        if (Array.isArray(v)) {
          if (!q.multiSelect && v.length > 1) return reject(`question "${q.question}" accepts one answer`);
          const parts = v.map(cleanText).filter(Boolean);
          v = parts.join(', ');
        } else {
          v = cleanText(v);
        }
        if (!v) return reject(`no answer for "${q.question}"`);
        answers[q.question] = v;
      }
      break;
    }
    case 'cancel':
      if (question.payload.via === 'PermissionRequest') {
        return { ok: true, output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user dismissed this question without answering.' } } }, summary: 'dismissed' };
      }
      return {
        ok: true,
        output: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'The user dismissed this question from Google Chat without answering. Ask again later or continue without it.',
          },
        },
        summary: 'dismissed',
      };
    default:
      return reject(`response type "${response.type}" is not valid for AskUserQuestion`);
  }
  const updatedInput = { ...toolInput, answers };
  // Same answer, two official delivery paths (both verified against Claude Code 2.1.280).
  const output = question.payload.via === 'PermissionRequest'
    ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } };
  return { ok: true, output, summary: Object.values(answers).join(' | ') };
}
