import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QaEvalCase } from './schemas.js';

const CASES = fileURLToPath(new URL('../../../../evals/policy_qa/cases.jsonl', import.meta.url));

describe('policy_qa static files', () => {
  it('policy-qa evals: cases.jsonl parses as QaEvalCase with ids exactly EV-1 to EV-36', () => {
    expect(existsSync(CASES)).toBe(true);
    const lines = readFileSync(CASES, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const ids = lines.map((line) => QaEvalCase.parse(JSON.parse(line)).id);
    const expected = Array.from({ length: 36 }, (_, i) => `EV-${String(i + 1)}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expected].sort());
  });
});
