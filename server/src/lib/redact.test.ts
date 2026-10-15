import { describe, expect, it } from 'vitest';
import { redact, redactText } from './redact.js';

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const child of Object.values(v)) {
      deepFreeze(child);
    }
    Object.freeze(v);
  }
  return v;
}

describe('redactText', () => {
  it('AT-36: replaces every email address with [EMAIL]', () => {
    expect(redactText('Contact alex.doe@corp.example or sam@hr.test')).toBe(
      'Contact [EMAIL] or [EMAIL]',
    );
  });

  it('AT-37: replaces phone numbers with [PHONE]', () => {
    expect(redactText('call 555-0142 or (555) 010-0199')).toBe('call [PHONE] or [PHONE]');
  });

  it('AT-37: replaces ID-like numbers with [ID]', () => {
    expect(redactText('ref 000-00-0000 and 900000001')).toBe('ref [ID] and [ID]');
  });

  it('AT-38: leaves synthetic domain ids, ISO dates and decimals unchanged', () => {
    const s = 'emp-001 on 2026-11-16 for 0.5 days, team-a';
    expect(redactText(s)).toBe(s);
  });
});

describe('redact', () => {
  it('AT-39: deep-copies frozen input, redacts strings and keys, is idempotent', () => {
    const input = deepFreeze({
      a: [{ note: 'x@y.example', ok: true, n: null }],
      'k@z.example': 1,
    });
    const snapshot = JSON.stringify(input);

    let out: unknown;
    expect(() => {
      out = redact(input);
    }).not.toThrow();

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toEqual({
      a: [{ note: '[EMAIL]', ok: true, n: null }],
      '[EMAIL]': 1,
    });
    expect(out).not.toBe(input);
    expect(redact(out)).toEqual(out);
  });

  it('redact: stays linear on long adversarial input (no ReDoS)', () => {
    const n = 100_000;
    for (const input of ['a'.repeat(n), '1-'.repeat(n / 2), `${'a.'.repeat(n / 2)}@`]) {
      const start = performance.now();
      redactText(input);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it('redact: masks international phones, spaced IDs and 6+ digit runs (D-7)', () => {
    expect(redactText('call +44 20 7946 0958 or +1 555 010 0199')).toBe('call [PHONE] or [PHONE]');
    expect(redactText('ref 000 00 0000 and 000.00.0000')).toBe('ref [ID] and [ID]');
    expect(redactText('badge 123456, code 12345')).toBe('badge [ID], code 12345');
  });

  it('redact: the new patterns stay linear on long adversarial input', () => {
    const n = 100_000;
    for (const input of [`${'1'.repeat(n)}a`, `+1 ${'1 '.repeat(n / 2)}`, '1 '.repeat(n / 2)]) {
      const start = performance.now();
      redactText(input);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it('redact: many international-looking prefixes in one long input stay linear', () => {
    const input = `+1${'2'.repeat(20)} `.repeat(5_000);
    const start = performance.now();
    redactText(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
