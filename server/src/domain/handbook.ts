// Handbook helpers (spec policy-qa, rules 1, 2, 6). Pure: no I/O, clock or randomness. The agent
// sends exactly handbookBody(raw) as the document data, and the gate checks citations against the
// same string (DD-3), so neither ever computes it separately.
import { z } from 'zod';

export class HandbookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandbookFormatError';
  }
}

const DELIMITER = /^---(\r?\n)/;
const CLOSING = /(^|\n)---(\r?\n)/; // rule 1: a delimiter line ends with \n or \r\n
const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Removes the leading YAML frontmatter and returns the rest unchanged: no trimming, no line-ending
 * conversion, no Unicode normalization (rule 1). A body with a character outside the BMP is
 * rejected so the API's character indices and JavaScript's `slice` indices agree (DD-14).
 */
export function handbookBody(raw: string): string {
  const open = DELIMITER.exec(raw);
  if (open === null) throw new HandbookFormatError('handbook has no frontmatter');
  const rest = raw.slice(open[0].length);
  const close = CLOSING.exec(rest);
  if (close === null) throw new HandbookFormatError('handbook frontmatter never closes');
  const body = rest.slice(close.index + close[0].length);
  if (SURROGATE.test(body)) {
    throw new HandbookFormatError('handbook body has a character outside the BMP');
  }
  return body;
}

/** Collapses every run of `\s` to one space and trims. Nothing else (DD-2). */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * normalizeWs, plus a map from each normalized index to the raw index it came from. `map` has one
 * extra entry so a normalized end index maps too: map[i] is the raw start of normalized char i,
 * and map[text.length] is the raw index just past the last kept character.
 */
export function normalizeWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;
  let lastEnd = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (/\s/.test(ch)) {
      if (text.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      text += ' ';
      map.push(lastEnd);
      pendingSpace = false;
    }
    text += ch;
    map.push(i);
    lastEnd = i + 1;
  }
  map.push(lastEnd);
  return { text, map };
}

export const SectionId = z.string().regex(/^HB-\d+\.\d+$/);
export type SectionIdT = z.infer<typeof SectionId>;

export const HandbookSection = z
  .object({
    id: SectionId,
    start: z.number().int().nonnegative(), // index of the '#' of its "### HB-n.m" line
    headingEnd: z.number().int().positive(), // just past that heading line's line ending
    end: z.number().int().positive(), // exclusive: the next heading line, or body.length (DD-12)
  })
  .strict();
export type HandbookSection = z.infer<typeof HandbookSection>;

export interface BodyLine {
  start: number; // index of the line's first character
  end: number; // index just past its line ending (or body.length on the last line)
  text: string; // the line without its line ending
}

/** Every line of the body with its raw offsets. */
export function bodyLines(body: string): BodyLine[] {
  const lines: BodyLine[] = [];
  let start = 0;
  while (start < body.length) {
    const nl = body.indexOf('\n', start);
    const end = nl === -1 ? body.length : nl + 1;
    const text = body.slice(start, nl === -1 ? end : nl).replace(/\r$/, '');
    lines.push({ start, end, text });
    start = end;
  }
  return lines;
}

/** A heading line starts with one to three '#' characters followed by a space (DD-12). */
export function isHeadingLine(text: string): boolean {
  return /^#{1,3} /.test(text);
}

const SECTION_HEADING = /^### (HB-\d+\.\d+)\b/;

/** Every `### HB-n.m` section of the body, in order (rule 2). */
export function handbookSections(body: string): HandbookSection[] {
  const lines = bodyLines(body);
  const sections: HandbookSection[] = [];
  const seen = new Set<string>();
  let open: { id: string; start: number; headingEnd: number } | null = null;
  for (const line of lines) {
    if (!isHeadingLine(line.text)) continue;
    if (open !== null) {
      sections.push({ ...open, end: line.start });
      open = null;
    }
    const m = SECTION_HEADING.exec(line.text);
    if (m?.[1] === undefined) continue;
    if (seen.has(m[1])) throw new HandbookFormatError(`duplicate section id ${m[1]}`);
    seen.add(m[1]);
    open = { id: m[1], start: line.start, headingEnd: line.end };
  }
  if (open !== null) sections.push({ ...open, end: body.length });
  if (sections.length === 0) throw new HandbookFormatError('handbook has no sections');
  return sections;
}
