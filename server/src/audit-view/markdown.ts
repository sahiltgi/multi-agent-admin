// A small markdown subset turned into structured blocks (spec audit-view, rules 17 and 18). Pure:
// no I/O, no clock. Only ATX headings # to ###, pipe tables, "- " lists and paragraphs are
// recognised; everything else (raw HTML, links, images, emphasis, deeper headings, fences) stays
// as literal text. Document text is data: an instruction inside it is just text (HARD RULE 3).
import {
  INLINE_CHARS,
  MAX_DOC_BLOCKS,
  type AiLogState,
  type DocBlock,
  type Inline,
} from './schemas.js';

type Cells = Inline[][];

const HEADING_RE = /^(#{1,3})[ \t]+(.*)$/; // the text is trimmed in code: no backtracking
const SEPARATOR_RE = /^\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;
const LIST_RE = /^- (.*)$/;

const clip = (text: string): string => text.slice(0, INLINE_CHARS);

/** Splits text into `text` and backtick `code` runs. Nothing else is interpreted. */
function inlines(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of source.matchAll(/`([^`]+)`/g)) {
    if (m.index > last) out.push({ kind: 'text', text: clip(source.slice(last, m.index)) });
    out.push({ kind: 'code', text: clip(m[1] ?? '') });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ kind: 'text', text: clip(source.slice(last)) });
  return out;
}

/** Splits a table row on unescaped pipes; `\|` is a literal `|`. */
function cells(row: string): Cells {
  let body = row.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      out.push(cell);
      cell = '';
    } else {
      cell += ch ?? '';
    }
  }
  out.push(cell);
  return out.map((c) => inlines(c.trim()));
}

const isTableStart = (lines: readonly string[], i: number): boolean =>
  (lines[i] ?? '').trimStart().startsWith('|') && SEPARATOR_RE.test((lines[i + 1] ?? '').trim());
const isBlank = (line: string): boolean => line.trim() === '';

function parseBlocks(text: string, maxBlocks: number): DocBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: DocBlock[] = [];
  let i = 0;
  while (i < lines.length && blocks.length < maxBlocks) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, inlines: inlines((heading[2] ?? '').trim()) });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = cells(line);
      const rows: Cells[] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (LIST_RE.test(line)) {
      const items: Inline[][] = [];
      let item = LIST_RE.exec(lines[i] ?? '');
      while (item !== null) {
        items.push(inlines(item[1] ?? ''));
        i += 1;
        item = LIST_RE.exec(lines[i] ?? '');
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i] ?? '')) {
      para.push((lines[i] ?? '').trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inlines: inlines(para.join(' ')) });
  }
  return blocks;
}

/** Rule 17: at most 500 blocks; inline text is cut at 2,000 characters. */
export function parseMarkdownBlocks(text: string): DocBlock[] {
  return parseBlocks(text, MAX_DOC_BLOCKS);
}

const cellText = (cell: readonly Inline[]): string =>
  cell
    .map((x) => x.text)
    .join('')
    .trim()
    .toLowerCase();

/**
 * Rule 18: the first table whose header has `Date` and `Fix or rule added` cells (as in
 * dev-metrics rule 12). Its first `n` data rows in file order, never re-sorted.
 */
export function latestTableRows(text: string, n: number): AiLogState {
  for (const block of parseBlocks(text, Number.POSITIVE_INFINITY)) {
    if (block.kind !== 'table') continue;
    const names = block.header.map(cellText);
    if (!names.includes('date') || !names.includes('fix or rule added')) continue;
    return {
      status: 'ok',
      header: block.header,
      rows: block.rows.slice(0, n),
      totalRows: block.rows.length,
    };
  }
  return { status: 'no_table' };
}
