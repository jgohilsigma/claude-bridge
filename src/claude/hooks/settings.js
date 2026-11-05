// Generates the Claude Code settings file that bridge-launched sessions receive via
// `claude --settings <file>`. Hooks from --settings are merged with the user's own settings
// (verified: existing ~/.claude/settings.json hooks keep running), so the user's configuration is
// never modified.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../config.js';

export const HOOK_SCRIPT = path.join(PROJECT_ROOT, 'src', 'claude', 'hooks', 'hook.js');

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

export function hookCommand() {
  // Absolute, quoted paths: the project may live in a directory containing spaces.
  return `${q(process.execPath)} ${q(HOOK_SCRIPT)}`;
}

export function buildHookSettings({ questionTimeoutSec }) {
  const cmd = hookCommand();
  const blockingTimeout = Math.max(60, Math.ceil(questionTimeoutSec) + 60);
  const quick = (timeout = 10) => [{ hooks: [{ type: 'command', command: cmd, timeout }] }];
  return {
    hooks: {
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: cmd, timeout: blockingTimeout }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: blockingTimeout }] }],
      Notification: quick(),
      Stop: quick(),
      UserPromptSubmit: quick(),
      SessionStart: quick(),
      SessionEnd: quick(5),
    },
  };
}

export function writeHookSettings(file, cfg) {
  const content = JSON.stringify(buildHookSettings(cfg), null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}
