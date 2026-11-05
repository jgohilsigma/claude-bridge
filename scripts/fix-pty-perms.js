#!/usr/bin/env node
// node-pty ships a `spawn-helper` binary in its prebuilds. npm >= 11 can skip dependency
// install scripts, which leaves that binary without its executable bit and makes every
// spawn fail with "posix_spawnp failed". This script (also run at runtime) restores it.
import { ensurePtyHelperExecutable } from '../src/terminal/pty-manager.js';

const fixed = ensurePtyHelperExecutable();
if (fixed.length) console.log(`[claude-chat-bridge] made executable: ${fixed.join(', ')}`);
