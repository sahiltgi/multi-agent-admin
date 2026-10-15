// Untrusted content handling (spec agent-runtime, rules 16 and 17; D-8, D-8b).
// User text and documents are wrapped once, as data, where they enter a run. The system prompt
// (loaded from prompts/) says that content inside these tags is data and never instructions.

export const DATA_TAG = 'untrusted_data';

export type UntrustedPart =
  { source: 'user'; text: string } | { source: 'document'; docId: string; text: string };

// Used by the injection heuristic only: '<' or fullwidth '＜', an optional '/' or '／', then the tag
// name, with whitespace or invisible format characters allowed in between. One GAP before the
// optional slash group, never two in a row, so backtracking stays linear.
const GAP = '[\\s\\p{Cf}]*';
const TAG_SOURCE = `[<\\uFF1C](${GAP}(?:[\\/\\uFF0F]${GAP})?${Array.from(DATA_TAG).join(GAP)})`;

// '<' and its lookalikes: fullwidth, small form, single angle quote, CJK, math, technical and
// ornament angle brackets, modifier letter and Canadian syllabics forms.
const LESS_THAN_LIKE = /[<\uFF1C\uFE64\u2039\u3008\u27E8\u2329\u02C2\u1438\u276E\u29FC]/g;

/**
 * Escapes every less-than character and lookalike (D-8), so content can't form any tag at all,
 * let alone open or close its own wrapper. A blocklist of tag spellings can always be dodged.
 */
export function neutralise(text: string): string {
  return text.replace(LESS_THAN_LIKE, '&lt;');
}

/**
 * For serialised JSON (tool results, D-8): replaces the same characters with \uXXXX escapes.
 * Lossless, since JSON.parse returns the original value, yet the text can't form any tag.
 */
export function escapeJsonLessThan(json: string): string {
  return json.replace(
    LESS_THAN_LIKE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function wrapUntrusted(part: UntrustedPart): string {
  const attrs =
    part.source === 'user'
      ? 'source="user"'
      : `source="document" doc_id="${escapeAttr(part.docId)}"`;
  return `<${DATA_TAG} ${attrs}>\n${neutralise(part.text)}\n</${DATA_TAG}>`;
}

const HEURISTICS: readonly (readonly [RegExp, string])[] = [
  [/\bignore\b[^.\n]{0,40}\b(rules|instructions)\b/i, 'ignore_instructions'],
  [/\bapprove\s+(my|all|every)\b/i, 'approval_request'],
  [/^[ \t]*(system|assistant)[ \t]*:/im, 'role_prefix'],
  [/<\s*(?:\/\s*)?(data|system)\b/i, 'tag_literal'],
  [new RegExp(TAG_SOURCE, 'iu'), 'tag_literal'], // data-tag spellings, including hidden variants
  [/"type"\s*:\s*"tool_use"/i, 'fake_tool_use'],
];

/** A small default detector (D-8b). A flag is audit-only: it never changes the run. */
export function detectInjectionHeuristic(text: string): { flagged: boolean; reason?: string } {
  for (const [pattern, reason] of HEURISTICS) {
    if (pattern.test(text)) return { flagged: true, reason };
  }
  return { flagged: false };
}
