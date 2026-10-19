import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LeaveEvalCase } from './schemas.js';

const CASES = fileURLToPath(new URL('../../../../evals/leave/cases.jsonl', import.meta.url));

describe('leave static files', () => {
  it('D-4: evals/leave/cases.jsonl parses as LeaveEvalCase with ids exactly EV-1 to EV-31 (chat-endpoint amendment: EV-22 to EV-31 added)', () => {
    expect(existsSync(CASES)).toBe(true);
    const lines = readFileSync(CASES, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const ids = lines.map((line) => LeaveEvalCase.parse(JSON.parse(line)).id);
    const expected = Array.from({ length: 31 }, (_, i) => `EV-${String(i + 1)}`);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual([...expected].sort());
  });
});
