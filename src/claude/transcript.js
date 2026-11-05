// Reads Claude Code's session transcript (the JSONL file whose path every hook event carries in
// `transcript_path`) to give emails context: what you asked, what Claude did since, and what it
// last said. Only the tail of the file is read, and any parsing problem just yields less context.
import fs from 'node:fs';
import path from 'node:path';
import { truncate } from '../util/ids.js';

const TAIL_BYTES = 1_500_000;

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text; // drop a partial first line
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

/** A prompt you typed (or an answer the bridge typed), as opposed to tool results / meta entries. */
function isRealPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const c = entry.message?.content;
  if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  return !/^<(command-|local-command|system-reminder|bash-|user-memory)/.test(t);
}

function cleanPrompt(t) {
  return t
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/<\/?(system-reminder|command-[a-z-]+)[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function rel(file, cwd) {
  if (!file) return '';
  const r = cwd ? path.relative(cwd, file) : file;
  return !r || r.startsWith('..') ? file : r;
}

export function describeTool(name, input = {}, cwd = '') {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Ran: ${truncate(String(input.command || '').split('\n')[0], 90)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${rel(input.file_path, cwd)}`;
    case 'Write':
      return `Wrote ${rel(input.file_path, cwd)}`;
    case 'NotebookEdit':
      return `Edited notebook ${rel(input.notebook_path, cwd)}`;
    case 'Read':
      return `Read ${rel(input.file_path, cwd)}`;
    case 'Grep':
    case 'Glob':
      return `Searched for ${truncate(String(input.pattern || ''), 50)}`;
    case 'WebFetch':
      try {
        return `Fetched ${new URL(input.url).hostname}`;
      } catch {
        return 'Fetched a web page';
      }
    case 'WebSearch':
      return `Searched the web: ${truncate(String(input.query || ''), 60)}`;
    case 'Task':
    case 'Agent':
      return `Delegated: ${truncate(String(input.description || input.prompt || ''), 70)}`;
    case 'TodoWrite':
    case 'AskUserQuestion':
    case 'ExitPlanMode':
      return null;
    default:
      return name.startsWith('mcp__') ? `Used ${name.replace(/^mcp__/, '').replace(/__/g, ' → ')}` : `Used ${name}`;
  }
}

/** Collapses the action list: merges repeated reads/searches and keeps the most recent entries. */
function summarizeActions(list, max = 10) {
  const out = [];
  let reads = 0;
  let searches = 0;
  for (const a of list) {
    if (a.startsWith('Read ')) reads++;
    else if (a.startsWith('Searched for ')) searches++;
    else if (out[out.length - 1] !== a) out.push(a);
  }
  const extra = [];
  if (reads) extra.push(`Read ${reads} file${reads > 1 ? 's' : ''}`);
  if (searches) extra.push(`Searched the code ${searches} time${searches > 1 ? 's' : ''}`);
  const hidden = Math.max(0, out.length - max);
  const tail = out.slice(-max);
  if (hidden) tail.unshift(`… and ${hidden} earlier step${hidden > 1 ? 's' : ''}`);
  return [...extra, ...tail];
}

/**
 * @returns {{ task: string, actions: string[], lastMessage: string, toolCount: number } | null}
 */
export function extractContext(transcriptPath, { cwd = '', fallbackTask = '' } = {}) {
  let entries = [];
  try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      entries = readTail(transcriptPath)
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e) => e && (e.type === 'user' || e.type === 'assistant'));
    }
  } catch {
    entries = [];
  }
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealPrompt(entries[i])) {
      start = i;
      break;
    }
  }
  const task = start >= 0 ? cleanPrompt(textOf(entries[start].message.content)) : cleanPrompt(fallbackTask || '');
  const actions = [];
  let lastMessage = '';
  let toolCount = 0;
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type === 'tool_use') {
        toolCount++;
        const d = describeTool(c.name, c.input, cwd);
        if (d) actions.push(d);
      } else if (c?.type === 'text' && c.text?.trim()) {
        lastMessage = c.text.trim();
      }
    }
  }
  if (!task && !actions.length && !lastMessage) return null;
  return {
    task: truncate(task, 700),
    actions: summarizeActions(actions).map((a) => truncate(a, 110)),
    lastMessage: truncate(lastMessage, 1500),
    toolCount,
  };
}
