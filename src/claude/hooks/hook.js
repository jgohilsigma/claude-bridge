#!/usr/bin/env node
// Claude Code hook entrypoint for sessions launched through the bridge.
//
// Contract: read the hook event JSON from stdin, forward it to the local daemon, print the
// daemon's decision (if any) as JSON on stdout and exit 0.
//
// Fail-open rule: if this session wasn't launched by the bridge, the daemon is unreachable, or no
// answer arrives in time, print nothing. Claude Code then falls back to its normal terminal prompt.
// This hook never approves anything on its own.
import crypto from 'node:crypto';
import { DaemonClient } from '../../daemon/client.js';
import { bridgeHome } from '../../config.js';
import { sleep } from '../../util/ids.js';

const BLOCKING = new Set(['PermissionRequest', 'PreToolUse']);

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

async function main() {
  const sessionId = process.env.BRIDGE_SESSION_ID;
  const raw = await readStdin();
  if (!sessionId || !raw) return;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  const client = new DaemonClient(process.env.BRIDGE_HOME || bridgeHome());
  const blocking = BLOCKING.has(event.hook_event_name);
  // One idempotency key per hook invocation: retries after a daemon restart re-attach to the same question.
  const key = crypto.randomUUID();
  const deadline = Date.now() + (blocking ? Number(process.env.BRIDGE_HOOK_MAX_WAIT_MS || 24 * 3600 * 1000) : 8000);
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await client.post(
        '/hook',
        { sessionId, idempotencyKey: key, event },
        { timeoutMs: blocking ? Math.max(1000, deadline - Date.now()) : 5000 },
      );
      if (res?.output) process.stdout.write(JSON.stringify(res.output));
      return;
    } catch (err) {
      // Not connected to a daemon at all on the first try: fail open immediately.
      if (err.code === 'ENODAEMON' || (attempt === 0 && err.code === 'ECONNREFUSED' && !blocking)) return;
      if (err.status && err.status < 500) return; // rejected (unknown session etc.): fail open
      attempt++;
      if (!blocking && attempt >= 3) return;
      // Blocking: the daemon may be restarting; keep retrying with the same idempotency key, but if
      // it never comes back within 30s fall back to the terminal prompt.
      if (blocking && attempt > 60) return;
      await sleep(500);
      client.refresh();
    }
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
