// Detects interactive prompts on a terminal screen snapshot:
//   - menus with a cursor marker (numbered like Claude's "❯ 1. Yes" or unnumbered like
//     "❯ No, exit / Yes, I trust this folder"),
//   - yes/no confirmations ("Continue? (y/n)"),
//   - optional generic text prompts ("Project name: ").
// Returns null when nothing interactive is on screen.
import { sha1 } from '../util/ids.js';

const CURSOR = '❯›▶➤→>';
const CURSOR_LINE = new RegExp(`^(\\s*)([${CURSOR}])\\s+(\\S.*)$`);
const NUMBERED = /^(\s*)(?:[❯›▶➤→>]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const SEPARATOR = /^\s*[─━═\-_]{8,}\s*$/;
const HINT = /enter to|esc to cancel|arrow keys|↑|↓|to select|to navigate|space to|tab to amend|confirm/i;
const YES_NO = /(\((?:y|Y)\/(?:n|N)\)|\[(?:y|Y)\/(?:n|N)\]|\((?:yes|Yes)\/(?:no|No)\)|\[(?:yes|Yes)\/(?:no|No)\])\s*[:?]?\s*$/;

const textCol = (line) => line.search(/\S/);
const isBlank = (line) => !line || !line.trim();

function lastNonBlank(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (!isBlank(lines[i])) return i;
  return -1;
}

function collectQuestion(lines, from) {
  const out = [];
  let blanks = 0;
  for (let i = from; i >= 0 && out.length < 8; i--) {
    const l = lines[i];
    if (SEPARATOR.test(l)) break;
    if (isBlank(l)) {
      if (out.length && ++blanks >= 2) break;
      continue;
    }
    blanks = 0;
    out.unshift(l.trim());
  }
  return out.join('\n').trim();
}

function detectMenu(lines) {
  const bottom = lastNonBlank(lines);
  if (bottom < 0) return null;
  // Look for a cursor-marked line near the bottom of the screen.
  for (let c = bottom; c >= Math.max(0, bottom - 25); c--) {
    const m = CURSOR_LINE.exec(lines[c]);
    if (!m) continue;
    const num = NUMBERED.exec(lines[c]);
    const numbered = !!num;
    const markerCol = m[1].length;
    const optCol = numbered ? lines[c].indexOf(num[2], markerCol + 1) : lines[c].indexOf(m[3]);
    const isOption = (l) => {
      if (isBlank(l)) return null;
      if (numbered) {
        const n = NUMBERED.exec(l);
        if (n && l.indexOf(n[2], n[1].length) === optCol) return { n: Number(n[2]), label: n[3].trim() };
        return null;
      }
      const cm = CURSOR_LINE.exec(l);
      if (cm && cm[1].length === markerCol) return { label: cm[3].trim() };
      if (textCol(l) === optCol && !SEPARATOR.test(l)) return { label: l.trim() };
      return null;
    };
    const isContinuation = (l) => !isBlank(l) && textCol(l) > optCol && !SEPARATOR.test(l);
    // Expand upwards.
    let start = c;
    for (let i = c - 1; i >= 0; i--) {
      if (isOption(lines[i])) start = i;
      else if (isContinuation(lines[i]) && i > 0 && (isOption(lines[i - 1]) || isContinuation(lines[i - 1]))) continue;
      else break;
    }
    // Expand downwards.
    let end = c;
    for (let i = c + 1; i <= bottom; i++) {
      if (isOption(lines[i]) || isContinuation(lines[i])) end = i;
      else break;
    }
    const options = [];
    let cursorIndex = -1;
    for (let i = start; i <= end; i++) {
      const o = isOption(lines[i]);
      if (o) {
        if (i === c) cursorIndex = options.length;
        options.push(o);
      } else if (options.length) {
        options[options.length - 1].label += ' ' + lines[i].trim();
      }
    }
    if (options.length < 2 || options.length > 12 || cursorIndex < 0) continue;
    if (numbered && !options.every((o, idx) => o.n === idx + 1)) continue;
    // Claude's own input box is a single "❯" line between separators; never a menu.
    if (SEPARATOR.test(lines[start - 1] || '') && SEPARATOR.test(lines[end + 1] || '')) continue;
    // A live prompt sits at the bottom of the screen: anything printed after it (other than
    // key hints such as "Enter to confirm · Esc to cancel") means it's an old, answered menu.
    const trailing = lines.slice(end + 1, bottom + 1).filter((l) => !isBlank(l));
    if (trailing.length > 3 || trailing.some((l) => !HINT.test(l))) continue;
    const below = lines.slice(end + 1, Math.min(lines.length, end + 4)).join(' ');
    const question = collectQuestion(lines, start - 1);
    if (!numbered && !HINT.test(below) && !/\?\s*(\(.*\))?\s*$|:\s*$|arrow keys/i.test(question)) continue;
    return {
      kind: 'menu',
      question: question || 'Select an option',
      options: options.map((o) => ({ label: o.label.replace(/\s+/g, ' ').slice(0, 200), description: '' })),
      cursorIndex,
      numbered,
      hint: below.trim().slice(0, 200),
    };
  }
  return null;
}

function detectYesNo(lines) {
  const bottom = lastNonBlank(lines);
  if (bottom < 0) return null;
  const line = lines[bottom];
  const m = YES_NO.exec(line);
  if (!m) return null;
  const marker = m[1];
  const defaultYes = /Y/.test(marker.split('/')[0]);
  const defaultNo = /N/.test(marker.split('/')[1]);
  const before = collectQuestion(lines, bottom - 1);
  const q = line.slice(0, m.index).trim();
  return {
    kind: 'yes_no',
    question: [before.split('\n').slice(-3).join('\n'), q].filter(Boolean).join('\n') || 'Confirm?',
    options: [{ label: defaultYes ? 'Yes (default)' : 'Yes', description: '' }, { label: defaultNo ? 'No (default)' : 'No', description: '' }],
    cursorIndex: 0,
  };
}

function detectTextPrompt(lines, cursorRow, cursorCol) {
  const bottom = lastNonBlank(lines);
  if (bottom < 0 || cursorRow !== bottom) return null;
  const line = lines[bottom];
  if (!/[:?]\s*$/.test(line) || cursorCol < line.trimEnd().length) return null;
  if (CURSOR_LINE.test(line) || /\$\s*$|#\s*$|%\s*$/.test(line)) return null; // shell prompts
  return { kind: 'text_prompt', question: collectQuestion(lines, bottom) || line.trim(), options: [], cursorIndex: 0 };
}

export function detectPrompt(snapshot, { textPrompts = false } = {}) {
  const { lines, cursorRow = -1, cursorCol = 0 } = snapshot;
  const found = detectMenu(lines) || detectYesNo(lines) || (textPrompts ? detectTextPrompt(lines, cursorRow, cursorCol) : null);
  if (!found) return null;
  found.fingerprint = fingerprint(found);
  return found;
}

export function fingerprint(p) {
  return sha1([p.kind, p.question, ...(p.options || []).map((o) => o.label)].join('␞')).slice(0, 16);
}
