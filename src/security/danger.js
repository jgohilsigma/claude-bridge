// Classifies tool calls that need an extra confirmation step before they can be approved from
// Google Chat (and that are never eligible for "allow for session" or auto-approval).

const BASH_RULES = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, 'recursive/forced file deletion (rm -rf)'],
  [/\b(rmdir|shred|unlink)\b/i, 'file deletion'],
  [/\bfind\b[^|]*\s-delete\b/i, 'file deletion (find -delete)'],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|--force-with-lease)/i, 'force push'],
  [/\bgit\s+push\b/i, 'git push (publishes code)'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|filter-branch|rebase)\b/i, 'destructive git operation'],
  [/\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b/i, 'destructive SQL'],
  [/\b(kubectl\s+(delete|apply|rollout|scale)|helm\s+(install|upgrade|uninstall|delete))\b/i, 'Kubernetes change'],
  [/\bterraform\s+(apply|destroy|import)\b|\bpulumi\s+(up|destroy)\b/i, 'infrastructure change'],
  [/\b(deploy|deployment)\b|\b(vercel|netlify)\b.*--prod|\bfirebase\s+deploy\b|\bfly\s+deploy\b|\bheroku\b|\bgcloud\s+(app|run|functions)\s+deploy\b|\baws\s+.*\b(deploy|delete|terminate)/i, 'deployment'],
  [/\bnpm\s+(publish|unpublish)\b|\b(yarn|pnpm)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b/i, 'package publish'],
  [/\bsudo\b|\bsu\s+-?\b|\bdoas\b/i, 'privilege escalation'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python|node)\b/i, 'pipes remote script into a shell'],
  [/\b(mkfs|fdisk|diskutil\s+erase|dd\s+if=|format\s+[a-z]:)/i, 'disk operation'],
  [/\b(shutdown|reboot|halt|poweroff|killall|pkill)\b|\bkill\s+-9\b/i, 'process/system control'],
  [/\bchmod\s+(-R\s+)?(777|a\+w)|\bchown\s+-R\b/i, 'permission change'],
  [/\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f|rmi)\b/i, 'docker cleanup'],
  [/(\.env\b|id_rsa|id_ed25519|\.ssh\/|\.aws\/credentials|\.npmrc|\.netrc|\.pgpass|credentials\.json|service[-_]?account.*\.json|\.pem\b|\.p12\b|\.key\b)/i, 'credential/secret file access'],
  [/\b(security\s+find-(generic|internet)-password|gcloud\s+auth\s+print-access-token|aws\s+configure\s+get|printenv|env\s*$)/i, 'credential access'],
  [/\b(eval|exec)\b.*\$\(/i, 'dynamic shell evaluation'],
];

const PATH_RULES = [
  [/(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|id_ed25519|\/\.ssh\/|\.aws\/credentials|credentials\.json$|\.npmrc$|\.netrc$/i, 'credential/secret file'],
  [/(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|Jenkinsfile$|(^|\/)deploy/i, 'CI/CD or deployment configuration'],
  [/(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)\.git\/(config|hooks)/i, 'tool/agent configuration'],
];

export function classifyDanger(toolName, toolInput = {}, extraPatterns = []) {
  const reasons = new Set();
  const input = toolInput || {};
  if (toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'Monitor') {
    const cmd = String(input.command || '');
    for (const [re, why] of BASH_RULES) if (re.test(cmd)) reasons.add(why);
    if (toolName === 'PowerShell' && /\bRemove-Item\b.*-Recurse|\bFormat-Volume\b|\bStop-Computer\b/i.test(cmd)) reasons.add('destructive PowerShell');
  }
  const filePath = String(input.file_path || input.path || input.notebook_path || '');
  if (filePath && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'].includes(toolName)) {
    for (const [re, why] of PATH_RULES) if (re.test(filePath)) reasons.add(why);
  }
  if (/^mcp__/.test(toolName) && /delete|remove|drop|destroy|deploy|publish|send|transfer|payment/i.test(toolName)) {
    reasons.add('MCP tool with side effects');
  }
  const haystack = JSON.stringify(input);
  for (const p of extraPatterns || []) {
    try {
      if (new RegExp(p, 'i').test(haystack)) reasons.add(`matches custom pattern /${p}/`);
    } catch {
      /* ignore invalid user pattern */
    }
  }
  return { dangerous: reasons.size > 0, reasons: [...reasons] };
}
