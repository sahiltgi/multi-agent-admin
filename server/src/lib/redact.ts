// PII redaction for audit copies (spec agent-runtime, rules 19 and 21; patterns per D-7).
// Pure: no I/O, no clock. Applied only to what reaches the audit sink, never to model messages.

export const REDACTION_TOKENS = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  id: '[ID]',
} as const;

// Order matters: emails first, then international phones, then SSN-style and 6+ digit runs as
// IDs, then local phones.
// Tokens contain no digits or '@', so a second pass changes nothing (idempotent).
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // The lookbehind starts a match only at the start of a local-part run, keeping this linear.
  [/(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, REDACTION_TOKENS.email],
  // International phone: '+', a country code, then 2–5 short digit groups. Bounded repetition.
  // A separator is required between groups, so digits split one way only: linear per '+'.
  [/\+\d{1,3}(?:[\s.-]\d{1,4}){2,5}\b/g, REDACTION_TOKENS.phone],
  [/\b\d{3}[-\s.]\d{2}[-\s.]\d{4}\b/g, REDACTION_TOKENS.id],
  [/\b\d{6,}\b/g, REDACTION_TOKENS.id],
  [
    /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])?\b\d{3}[\s.-]\d{4}\b/g,
    REDACTION_TOKENS.phone,
  ],
];

/** Masks emails, ID-like numbers and phone numbers inside one string. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, token] of PATTERNS) {
    out = out.replace(pattern, token);
  }
  return out;
}

/**
 * Deep copy with every string (and object key) masked. Never mutates its input.
 * Non-string primitives are returned unchanged; numbers are never redacted (D-7).
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item: unknown) => redact(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // On a key collision after masking, the last value wins (audit copy only, D-7).
      // defineProperty, not assignment, so a '__proto__' key can't change the copy's prototype.
      Object.defineProperty(out, redactText(key), {
        value: redact(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
