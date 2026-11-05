#!/usr/bin/env node
import { commands, parseArgs } from '../src/cli/commands.js';

const [name = 'help', ...rest] = process.argv.slice(2);
const cmd = commands[name] || (['-h', '--help'].includes(name) ? commands.help : null);
if (!cmd) {
  console.error(`Unknown command "${name}".\n`);
  commands.help();
  process.exit(2);
}
try {
  await cmd(parseArgs(rest));
} catch (err) {
  console.error(`bridge ${name}: ${err.message}`);
  process.exit(1);
}
