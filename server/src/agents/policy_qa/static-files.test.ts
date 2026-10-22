import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QaEvalCase } from './schemas.js';

const CASES = fileURLToPath(new URL('../../../../evals/policy_qa/cases.jsonl', import.meta.url));
const HANDBOOK = fileURLToPath(new URL('../../../../handbook/handbook.md', import.meta.url));

function cases(): QaEvalCase[] {
  return readFileSync(CASES, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => QaEvalCase.parse(JSON.parse(line)));
}

describe('policy_qa static files', () => {
  it('policy-qa evals: cases.jsonl parses as QaEvalCase with ids exactly EV-1 to EV-40', () => {
    expect(existsSync(CASES)).toBe(true);
    const ids = cases().map((c) => c.id);
    const expected = Array.from({ length: 40 }, (_, i) => `EV-${String(i + 1)}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('policy-qa evals: every expected section id is a section heading in the handbook', () => {
    const headings = new Set(
      [...readFileSync(HANDBOOK, 'utf8').matchAll(/^### (HB-\d+\.\d+) /gm)].map((m) => m[1]),
    );
    for (const c of cases()) {
      for (const id of c.expected.sectionIds ?? [])
        expect(headings.has(id), `${c.id}: ${id}`).toBe(true);
    }
  });
});
