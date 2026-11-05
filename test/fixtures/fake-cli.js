// A tiny interactive CLI used by the runner tests: an arrow-key menu followed by a y/N prompt.
import readline from 'node:readline';

const items = ['staging', 'production', 'local'];
let cursor = 0;
const out = process.stdout;
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

function render(first) {
  if (!first) out.write(`\x1b[${items.length}A`);
  items.forEach((it, i) => out.write(`\x1b[2K${i === cursor ? '❯' : ' '} ${it}\r\n`));
}

out.write('Starting fake deploy tool…\r\n\r\n? Choose deployment target: (Use arrow keys)\r\n');
render(true);

function onMenuKey(_s, key) {
  if (key.name === 'up') cursor = (cursor + items.length - 1) % items.length;
  else if (key.name === 'down') cursor = (cursor + 1) % items.length;
  else if (key.name === 'return') {
    process.stdin.off('keypress', onMenuKey);
    out.write(`\r\nSELECTED: ${items[cursor]}\r\n\r\nProceed with cleanup? [y/N] `);
    let answer = '';
    process.stdin.on('keypress', (s, k) => {
      if (k && k.name === 'return') {
        out.write(`\r\nANSWER: ${answer || 'N'}\r\n`);
        setTimeout(() => process.exit(0), 200);
      } else if (s) {
        answer += s;
        out.write(s);
      }
    });
    return;
  } else if (key.ctrl && key.name === 'c') process.exit(130);
  render(false);
}
process.stdin.on('keypress', onMenuKey);
