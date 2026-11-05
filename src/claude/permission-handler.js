// PermissionRequest handling: optional explicit auto-approval rules, otherwise a Chat question.
// Permissions are never approved automatically unless the user configured a matching rule, and
// dangerous operations (deletion, deploys, credentials, force pushes...) are never auto-approved.
import { buildPermission, autoApproveMatch } from '../adapters/permission.js';

export function handlePermissionRequest(event, { cfg, db, sessionId }) {
  const spec = buildPermission(event, cfg);
  const rule = autoApproveMatch(cfg, spec.payload.toolName, spec.payload.toolInput, spec.payload.dangerous);
  if (rule) {
    db.audit({ actor: 'auto-approve', action: 'permission.auto_approved', sessionId, detail: { tool: spec.payload.toolName, summary: spec.payload.summary, rule } });
    return { output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } };
  }
  return { spec };
}
