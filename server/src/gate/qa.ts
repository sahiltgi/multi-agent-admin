// Policy Q&A Gate (spec policy-qa, rules 4-12). Pure: no clock, no I/O, no randomness, no model.
// Every verdict comes from the code below (HARD RULE 1); the model's confidence is never an input.
import { z } from 'zod';
import {
  HandbookFormatError,
  bodyLines,
  handbookSections,
  isHeadingLine,
  normalizeWithMap,
  normalizeWs,
  type BodyLine,
  type HandbookSection,
} from '../domain/handbook.js';
import {
  type QaGateResult,
  type QaRuleId,
  type QaRuleResult,
  type QaVerdict,
} from '../domain/qa.js';
import { LoadedQaPolicy, SENSITIVE_TOPICS, type SensitiveTopic } from './qa-policy.schema.js';

// ---- Schemas (spec "Inputs and outputs") ----

export const QaCitation = z
  .object({
    citedText: z.string(),
    startCharIndex: z.number().int().optional(), // from the API's char_location, never model-written
    endCharIndex: z.number().int().optional(), // exclusive
  })
  .strict();
export type QaCitation = z.infer<typeof QaCitation>;

/** Strict: a confidence, role, verdict or sectionIds key makes the input malformed (rule 12). */
export const QaGateInput = z
  .object({
    question: z.string(), // the employee's text: data, never echoed
    answerText: z.string(), // concatenated model text blocks: data, never echoed
    citations: z.array(QaCitation),
    handbookBody: z.string().min(1), // exactly handbookBody(raw), the string sent as document data
  })
  .strict();
export type QaGateInput = z.infer<typeof QaGateInput>;

/** Thrown only for an invalid `policy`, which comes from the boot-time loader, not user data. */
export class QaGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaGateInputError';
  }
}

// ---- Rule results and templates (rule 11: counts, positions, section ids, topics only) ----

const EXPECTED: Record<QaRuleId, string> = {
  citations_present: 'At least one handbook citation.',
  citations_verbatim: 'Every citation is verbatim inside one numbered handbook section.',
  topic_not_sensitive: 'No sensitive topic in the question or the answer.',
};
const VERDICT_SENTENCE: Record<QaVerdict, string> = {
  AUTO_ANSWER: 'All checks passed.',
  ESCALATE_TO_HR: 'Escalated to HR.',
};

const result = (
  ruleId: QaRuleId,
  passed: boolean,
  actual: string,
  message: string,
): QaRuleResult => ({
  ruleId,
  passed,
  expected: EXPECTED[ruleId],
  actual,
  message,
});
const notChecked = (ruleId: QaRuleId, cause: string): QaRuleResult =>
  result(ruleId, false, 'not checked', `Not checked because ${cause}.`);

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

// ---- Locating a citation (rule 8) ----

type CitationFailure =
  | 'is empty'
  | 'was not found in the handbook'
  | 'matches more than one place in the handbook'
  | 'is heading only'
  | 'is outside any numbered section'
  | 'spans more than one section'
  | "includes another section's heading";

type Located = { ok: true; start: number; end: number } | { ok: false; why: CitationFailure };

/** Every start index of `needle` in `hay`, overlapping occurrences included. */
function occurrences(hay: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) found.push(i);
  return found;
}

interface Body {
  text: string;
  normalized: { text: string; map: number[] };
  lines: BodyLine[];
  sections: HandbookSection[];
}

function locate(c: QaCitation, body: Body): Located {
  const wanted = normalizeWs(c.citedText);
  if (wanted === '') return { ok: false, why: 'is empty' };
  const { startCharIndex: s, endCharIndex: e } = c;
  if (s !== undefined && e !== undefined && s >= 0 && s < e && e <= body.text.length) {
    if (normalizeWs(body.text.slice(s, e)) === wanted) return { ok: true, start: s, end: e };
  }
  const hits = occurrences(body.normalized.text, wanted);
  if (hits.length === 0) return { ok: false, why: 'was not found in the handbook' };
  if (hits.length > 1) return { ok: false, why: 'matches more than one place in the handbook' };
  const ns = hits[0] ?? 0;
  const map = body.normalized.map;
  const start = map[ns] ?? 0;
  const end = (map[ns + wanted.length - 1] ?? 0) + 1;
  return { ok: true, start, end };
}

// ---- Mapping a located span to one section (rule 9; DD-13) ----

/** The heading lines that have at least one non-whitespace character inside [start, end). */
function headingLinesIn(body: Body, start: number, end: number): BodyLine[] {
  return body.lines.filter((l) => {
    if (!isHeadingLine(l.text) || l.end <= start || l.start >= end) return false;
    const lo = Math.max(l.start, start);
    const hi = Math.min(l.start + l.text.length, end);
    return /\S/.test(body.text.slice(lo, hi));
  });
}

/** The chapter heading directly above a section: the nearest non-blank line before its ### line. */
function chapterHeadingAbove(body: Body, section: HandbookSection): BodyLine | null {
  const before = body.lines.filter((l) => l.end <= section.start && l.text.trim() !== '');
  const above = before.at(-1);
  // Only a chapter heading `## HB-n` counts (rule 9), not any other `## ` line.
  return above !== undefined && /^## HB-\d+\b/.test(above.text) ? above : null;
}

function sectionOf(
  body: Body,
  start: number,
  end: number,
): { ok: true; id: string } | { ok: false; why: CitationFailure } {
  const headings = headingLinesIn(body, start, end);
  const onHeading = (p: number): boolean => headings.some((l) => p >= l.start && p < l.end);
  const ids = new Set<string>();
  let bodyChars = 0;
  let outside = false;
  for (let p = start; p < end; p++) {
    if (/\s/.test(body.text.charAt(p)) || onHeading(p)) continue;
    bodyChars += 1;
    const s = body.sections.find((x) => p >= x.headingEnd && p < x.end);
    if (s === undefined) outside = true;
    else ids.add(s.id);
  }
  if (bodyChars === 0) return { ok: false, why: 'is heading only' };
  if (outside) return { ok: false, why: 'is outside any numbered section' };
  if (ids.size > 1) return { ok: false, why: 'spans more than one section' };
  const id = [...ids][0] ?? '';
  const section = body.sections.find((x) => x.id === id);
  if (section === undefined) return { ok: false, why: 'is outside any numbered section' };
  const chapter = chapterHeadingAbove(body, section);
  const allowed = new Set([section.start, ...(chapter === null ? [] : [chapter.start])]);
  if (headings.some((l) => !allowed.has(l.start))) {
    return { ok: false, why: "includes another section's heading" };
  }
  return { ok: true, id };
}

function checkCitations(
  citations: readonly QaCitation[],
  body: Body,
): { rule: QaRuleResult; sectionIds: string[] } {
  if (citations.length === 0) {
    return { rule: notChecked('citations_verbatim', 'there are no citations'), sectionIds: [] };
  }
  const failures: string[] = [];
  const sectionIds: string[] = [];
  citations.forEach((c, i) => {
    const loc = locate(c, body);
    const mapped = loc.ok ? sectionOf(body, loc.start, loc.end) : loc;
    if (!mapped.ok) {
      failures.push(`citation ${String(i + 1)} ${mapped.why}`);
      return;
    }
    if (!sectionIds.includes(mapped.id)) sectionIds.push(mapped.id);
  });
  const verified = citations.length - failures.length;
  const actual = `${String(verified)} of ${plural(citations.length, 'citation', 'citations')} verified`;
  if (failures.length === 0) {
    const message = `${plural(citations.length, 'citation is', 'citations are')} verbatim in ${sectionIds.join(', ')}.`;
    return { rule: result('citations_verbatim', true, actual, message), sectionIds };
  }
  const message = `${failures.join('; ')}.`;
  return {
    rule: result(
      'citations_verbatim',
      false,
      actual,
      message.charAt(0).toUpperCase() + message.slice(1),
    ),
    sectionIds,
  };
}

// ---- Sensitive topics (rule 10) ----

const WORD = /[a-z0-9]/;

function containsPhrase(text: string, phrase: string): boolean {
  for (let i = text.indexOf(phrase); i !== -1; i = text.indexOf(phrase, i + 1)) {
    const before = i === 0 ? '' : text.charAt(i - 1);
    const after = text.charAt(i + phrase.length);
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

function checkTopics(question: string, answerText: string, policy: LoadedQaPolicy): QaRuleResult {
  const q = normalizeWs(question).toLowerCase();
  const a = normalizeWs(answerText).toLowerCase();
  const hits: string[] = [];
  for (const topic of SENSITIVE_TOPICS) {
    const phrases = policy.policy.sensitiveTopics[topic satisfies SensitiveTopic];
    const inQ = phrases.some((p) => containsPhrase(q, p));
    const inA = phrases.some((p) => containsPhrase(a, p));
    if (!inQ && !inA) continue;
    const where = inQ && inA ? 'question and answer' : inQ ? 'question' : 'answer';
    hits.push(`${topic} (${where})`);
  }
  if (hits.length === 0) {
    return result('topic_not_sensitive', true, 'none', 'No sensitive topic found.');
  }
  const label = hits.length === 1 ? 'Sensitive topic found' : 'Sensitive topics found';
  return result('topic_not_sensitive', false, hits.join(', '), `${label}: ${hits.join(', ')}.`);
}

// ---- Entry point ----

function finish(
  ruleResults: [QaRuleResult, QaRuleResult, QaRuleResult],
  sectionIds: string[],
  policy: LoadedQaPolicy,
): QaGateResult {
  const verdict: QaVerdict = ruleResults.every((r) => r.passed) ? 'AUTO_ANSWER' : 'ESCALATE_TO_HR';
  const failed = ruleResults.filter((r) => !r.passed).map((r) => r.message);
  return {
    verdict,
    ruleResults,
    reason: [VERDICT_SENTENCE[verdict], ...failed].join(' '),
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    sectionIds,
  };
}

function inputInvalid(policy: LoadedQaPolicy): QaGateResult {
  const cause = 'the input was invalid';
  return finish(
    [
      notChecked('citations_present', cause),
      notChecked('citations_verbatim', cause),
      notChecked('topic_not_sensitive', cause),
    ],
    [],
    policy,
  );
}

/**
 * Decides AUTO_ANSWER or ESCALATE_TO_HR from three rules, always all evaluated, in a fixed order
 * (rule 5). Malformed input escalates and never throws (rule 12).
 */
export function evaluateQa(input: QaGateInput, policy: LoadedQaPolicy): QaGateResult {
  const loaded = LoadedQaPolicy.safeParse(policy);
  if (!loaded.success) throw new QaGateInputError('policy is not a valid LoadedQaPolicy');
  const parsed = QaGateInput.safeParse(input);
  if (!parsed.success) return inputInvalid(loaded.data);
  const { question, answerText, citations, handbookBody } = parsed.data;

  let sections: HandbookSection[];
  try {
    sections = handbookSections(handbookBody);
  } catch (err) {
    if (err instanceof HandbookFormatError) return inputInvalid(loaded.data);
    throw err;
  }
  const body: Body = {
    text: handbookBody,
    normalized: normalizeWithMap(handbookBody),
    lines: bodyLines(handbookBody),
    sections,
  };

  const present =
    citations.length >= 1
      ? result(
          'citations_present',
          true,
          plural(citations.length, 'citation', 'citations'),
          `The answer cites the handbook ${plural(citations.length, 'time', 'times')}.`,
        )
      : result('citations_present', false, '0 citations', 'The answer has no handbook citation.');
  const verbatim = checkCitations(citations, body);
  const topic = checkTopics(question, answerText, loaded.data);
  return finish([present, verbatim.rule, topic], verbatim.sectionIds, loaded.data);
}
