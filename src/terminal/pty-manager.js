// Spawns processes in a pseudo-terminal (node-pty) so interactive TUIs such as Claude Code work
// exactly as in a normal terminal window.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Restores the executable bit on node-pty's spawn-helper (lost when install scripts are skipped). */
export function ensurePtyHelperExecutable() {
  if (process.platform === 'win32') return [];
  const fixed = [];
  let root;
  try {
    root = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return fixed;
  }
  const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
  const prebuilds = path.join(root, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const d of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, d, 'spawn-helper'));
  }
  for (const f of candidates) {
    try {
      const st = fs.statSync(f);
      if (!(st.mode & 0o111)) {
        fs.chmodSync(f, st.mode | 0o755);
        fixed.push(f);
      }
    } catch {
      /* not present */
    }
  }
  return fixed;
}

/** Environment for the child: drop markers that make a nested Claude Code think it is a subprocess. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

export function spawnPty(file, args, { cwd, cols = 120, rows = 40, env } = {}) {
  ensurePtyHelperExecutable();
  const pty = require('node-pty');
  const shellFile = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file) ? `${file}.cmd` : file;
  return pty.spawn(shellFile, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: process.platform === 'win32' ? true : undefined });
}
