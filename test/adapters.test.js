import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAskUserQuestion, askUserQuestionOutput } from '../src/adapters/ask-user-question.js';
import { buildPermission, permissionOutput, autoApproveMatch } from '../src/adapters/permission.js';
import { detectChoices, buildTurnFinished, freeTextInjection } from '../src/adapters/free-text.js';
import { menuKeys, yesNoKeys, textPromptKeys, KEYS } from '../src/adapters/terminal-prompts.js';
import { cleanText } from '../src/adapters/common.js';

const asQ = (spec) => ({ ...spec, payload: spec.payload, options: spec.options });

test('AskUserQuestion: option answer echoes questions and adds answers keyed by question text', () => {
  const input = { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo' }], multiSelect: false }] };
  const q = asQ(buildAskUserQuestion({ tool_input: input }));
  const r = askUserQuestionOutput(q, { type: 'option', value: { index: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers: { 'Which DB?': 'Mongo' } } } });
  assert.equal(askUserQuestionOutput(q, { type: 'option', value: { index: 5 } }).ok, false);
  assert.equal(askUserQuestionOutput(q, { type: 'text', value: { text: 'SQLite please' } }).output.hookSpecificOutput.updatedInput.answers['Which DB?'], 'SQLite please');
  assert.equal(askUserQuestionOutput(q, { type: 'allow', value: {} }).ok, false);
});

test('AskUserQuestion: multiple questions and multi-select join labels with commas', () => {
  const input = {
    questions: [
      { question: 'Features?', header: 'F', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }] },
      { question: 'Deploy now?', header: 'D', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  };
  const q = asQ(buildAskUserQuestion({ tool_input: input }));
  assert.deepEqual(q.options, []);
  assert.equal(askUserQuestionOutput(q, { type: 'option', value: { index: 0 } }).ok, false);
  const r = askUserQuestionOutput(q, { type: 'answers', value: { answers: { 'Features?': ['Auth', 'Billing'], 'Deploy now?': 'No' } } });
  assert.deepEqual(r.output.hookSpecificOutput.updatedInput.answers, { 'Features?': 'Auth, Billing', 'Deploy now?': 'No' });
  assert.equal(askUserQuestionOutput(q, { type: 'answers', value: { answers: { 'Features?': ['Auth'] } } }).ok, false);
  assert.equal(askUserQuestionOutput(q, { type: 'answers', value: { answers: { 'Features?': ['Auth'], 'Deploy now?': ['Yes', 'No'] } } }).ok, false);
});

test('permission: allow / deny / session-only rule; never persisted', () => {
  const q = asQ(buildPermission({ tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.equal(q.payload.dangerous, false);
  assert.deepEqual(permissionOutput(q, { type: 'allow' }).output.hookSpecificOutput.decision, { behavior: 'allow' });
  const s = permissionOutput(q, { type: 'allow_session' }).output.hookSpecificOutput.decision;
  assert.deepEqual(s.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }]);
  const d = permissionOutput(q, { type: 'deny', value: { message: 'not now' } }, { user: 'a@b.c' }).output.hookSpecificOutput.decision;
  assert.deepEqual(d, { behavior: 'deny', message: 'not now by a@b.c' });
});

test('permission: dangerous operations need explicit confirmation and never allow-for-session', () => {
  const q = asQ(buildPermission({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }));
  assert.equal(q.payload.dangerous, true);
  assert.equal(q.payload.allowSession, false);
  assert.equal(permissionOutput(q, { type: 'allow', value: {} }).ok, false);
  assert.equal(permissionOutput(q, { type: 'allow', value: { confirmed: true } }).ok, true);
  assert.equal(permissionOutput(q, { type: 'allow_session', value: {} }).ok, false);
});

test('permission: ExitPlanMode allow passes the plan back as updatedInput', () => {
  const q = asQ(buildPermission({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. do it' } }));
  assert.deepEqual(permissionOutput(q, { type: 'allow' }).output.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { plan: '1. do it' } });
});

test('auto-approve only with explicit rules and never for dangerous commands', () => {
  const cfg = { autoApprove: { rules: [{ tool: 'Bash', pattern: '^npm test$' }] } };
  assert.ok(autoApproveMatch(cfg, 'Bash', { command: 'npm test' }, false));
  assert.equal(autoApproveMatch(cfg, 'Bash', { command: 'npm test' }, true), null);
  assert.equal(autoApproveMatch(cfg, 'Bash', { command: 'npm publish' }, false), null);
  assert.equal(autoApproveMatch({ autoApprove: { rules: [] } }, 'Bash', { command: 'npm test' }, false), null);
});

test('turn-finished: numbered choices and yes/no questions are detected in Claude\'s message', () => {
  const msg = 'I found 11 test-case files with approximately 1,000 rows.\n\nWhat should I do?\n\n1. **Verify and fix failures**\n2. Verify only, report';
  assert.deepEqual(detectChoices(msg).options.map((o) => o.label), ['Verify and fix failures', 'Verify only, report']);
  assert.equal(detectChoices('Done. Should I also update the README?').type, 'yes_no');
  assert.equal(detectChoices('All tests pass.').type, 'none');
  assert.equal(detectChoices('Steps:\n1. a\n3. b').type, 'none');
  const q = asQ(buildTurnFinished({ last_assistant_message: msg }));
  assert.equal(freeTextInjection(q, { type: 'option', value: { index: 0 } }).text, 'Verify and fix failures');
  assert.equal(freeTextInjection(q, { type: 'text', value: { text: '  go ahead  ' } }).text, 'go ahead');
});

test('terminal prompt adapters produce verified key plans', () => {
  const menu = { options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], payload: { cursorIndex: 1 } };
  assert.deepEqual(menuKeys(menu, { type: 'option', value: { index: 2 } }).keys, [KEYS.down, KEYS.enter]);
  assert.deepEqual(menuKeys(menu, { type: 'option', value: { index: 0 } }).keys, [KEYS.up, KEYS.enter]);
  assert.equal(menuKeys(menu, { type: 'text', value: { text: 'x' } }).ok, false);
  assert.deepEqual(yesNoKeys({ options: [{ label: 'Yes' }, { label: 'No' }], payload: {} }, { type: 'option', value: { index: 0 } }).keys, ['y', '\r']);
  assert.equal(textPromptKeys({ payload: {} }, { type: 'text', value: { text: 'two\nlines' } }).ok, false);
});

test('control characters and escape sequences are stripped from typed text', () => {
  assert.equal(cleanText('hi\x1b[2J\x07 there\x03'), 'hi[2J there');
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText('x'.repeat(5000)), null);
});

test('AskUserQuestion arriving as a PermissionRequest is answered with decision.updatedInput', () => {
  const input = { questions: [{ question: 'Color?', header: 'C', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] };
  const q = asQ(buildAskUserQuestion({ tool_input: input }));
  q.payload.via = 'PermissionRequest';
  assert.deepEqual(askUserQuestionOutput(q, { type: 'option', value: { index: 1 } }).output, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...input, answers: { 'Color?': 'Blue' } } } },
  });
  assert.equal(askUserQuestionOutput(q, { type: 'cancel' }).output.hookSpecificOutput.decision.behavior, 'deny');
});
