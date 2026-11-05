// Adapter for Claude Code permission requests (PermissionRequest hook).
// Decisions: allow, allow for this session only (session-scoped rule, never persisted), deny.
import { classifyDanger } from '../security/danger.js';
import { cleanText, reject } from './common.js';
import { truncate } from '../util/ids.js';

export function summarizeTool(toolName, input = {}) {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return { summary: String(input.command || ''), detail: input.description || '' };
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read':
    case 'NotebookEdit':
      return { summary: String(input.file_path || input.notebook_path || ''), detail: toolName === 'Edit' && input.new_string ? `Replace text (${String(input.new_string).length} chars)` : '' };
    case 'WebFetch':
      return { summary: String(input.url || ''), detail: input.prompt ? truncate(input.prompt, 200) : '' };
    case 'WebSearch':
      return { summary: String(input.query || ''), detail: '' };
    case 'ExitPlanMode':
      return { summary: 'Approve plan and start implementing', detail: truncate(input.plan || '', 2500) };
    default:
      return { summary: truncate(JSON.stringify(input), 600), detail: '' };
  }
}

/** Narrow, session-only rule for "allow for session". Returns null if not offered. */
export function sessionRuleFor(toolName, input = {}) {
  if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') return null;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = String(input.command || '').trim();
    return cmd ? { toolName, ruleContent: cmd } : null;
  }
  if (toolName === 'WebFetch') {
    try {
      return { toolName, ruleContent: `domain:${new URL(input.url).hostname}` };
    } catch {
      return null;
    }
  }
  return { toolName };
}

export function buildPermission(event, cfg = {}) {
  const toolName = event.tool_name || 'unknown';
  const input = event.tool_input || {};
  const { summary, detail } = summarizeTool(toolName, input);
  const danger = classifyDanger(toolName, input, cfg.extraDangerousPatterns);
  const rule = danger.dangerous ? null : sessionRuleFor(toolName, input);
  return {
    kind: 'permission',
    eventType: 'PermissionRequest',
    title: toolName === 'ExitPlanMode' ? 'Plan approval requested' : `Permission request: ${toolName}`,
    question: truncate(summary, 1500),
    options: [],
    payload: {
      toolName,
      toolInput: input,
      summary: truncate(summary, 1500),
      detail: truncate(detail, 2500),
      dangerous: danger.dangerous,
      dangerReasons: danger.reasons,
      allowSession: !!rule,
      sessionRule: rule,
      blocking: true,
    },
  };
}

export function permissionOutput(question, response, { user } = {}) {
  const p = question.payload;
  const who = user ? ` by ${user}` : '';
  const allowDecision = (extra = {}) => ({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        ...(p.toolName === 'ExitPlanMode' ? { updatedInput: p.toolInput } : {}),
        ...extra,
      },
    },
  });
  switch (response.type) {
    case 'allow':
      if (p.dangerous && response.value?.confirmed !== true) return reject('dangerous operation requires explicit confirmation');
      return { ok: true, output: allowDecision(), summary: 'allowed' };
    case 'allow_session':
      if (!p.allowSession || !p.sessionRule || p.dangerous) return reject('"allow for session" is not available for this request');
      return {
        ok: true,
        output: allowDecision({
          updatedPermissions: [{ type: 'addRules', rules: [p.sessionRule], behavior: 'allow', destination: 'session' }],
        }),
        summary: 'allowed for session',
      };
    case 'deny':
    case 'cancel': {
      const reason = cleanText(response.value?.message || '') || (response.type === 'cancel' ? 'Cancelled from Google Chat' : 'Denied from Google Chat');
      return {
        ok: true,
        output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: `${reason}${who}` } } },
        summary: `denied: ${reason}`,
      };
    }
    default:
      return reject(`response type "${response.type}" is not valid for a permission request`);
  }
}

/** Optional user-configured auto approval. Never applies to dangerous operations. */
export function autoApproveMatch(cfg, toolName, input, dangerous) {
  if (dangerous) return null;
  for (const rule of cfg?.autoApprove?.rules || []) {
    if (rule.tool !== toolName) continue;
    const subject = toolName === 'Bash' ? String(input.command || '') : JSON.stringify(input);
    try {
      if (!rule.pattern || new RegExp(rule.pattern).test(subject)) return rule;
    } catch {
      /* invalid pattern: ignore */
    }
  }
  return null;
}
