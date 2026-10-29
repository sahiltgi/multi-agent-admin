// Eval growth to 40 cases per agent (brief §9): coverage across the four agent eval files.
// Lines past each file's pre-growth count are drafts; they carry `reviewed` until a human labels
// them, and never a value written by an agent other than false.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LeaveEvalCase } from './leave/schemas.js';
import { OnboardingEvalCase } from './onboarding/schemas.js';
import { OrchestratorEvalCase } from './orchestrator/schemas.js';
import { QaEvalCase } from './policy_qa/schemas.js';

interface Line {
  category: string;
  userText: string;
  tags: string[];
  reviewed?: boolean | undefined;
}

const FILES: { agent: string; file: string; preGrowth: number; parse: (v: unknown) => Line }[] = [
  {
    agent: 'orchestrator',
    file: 'orchestrator',
    preGrowth: 10,
    parse: (v) => OrchestratorEvalCase.parse(v),
  },
  { agent: 'leave', file: 'leave', preGrowth: 31, parse: (v) => LeaveEvalCase.parse(v) },
  { agent: 'policy_qa', file: 'policy_qa', preGrowth: 36, parse: (v) => QaEvalCase.parse(v) },
  {
    agent: 'onboarding',
    file: 'onboarding',
    preGrowth: 30,
    parse: (v) => OnboardingEvalCase.parse(v),
  },
];

function lines(file: string, parse: (v: unknown) => Line): Line[] {
  const path = fileURLToPath(new URL(`../../../evals/${file}/cases.jsonl`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => parse(JSON.parse(l)));
}

const added = FILES.map((f) => ({ ...f, cases: lines(f.file, f.parse).slice(f.preGrowth) }));

describe('eval growth: 40 cases per agent', () => {
  // At least 40: red-team cases (docs/red-team.md) are appended past the growth target.
  it('every agent file holds at least 40 cases', () => {
    for (const f of FILES) {
      expect(lines(f.file, f.parse).length, f.agent).toBeGreaterThanOrEqual(40);
    }
  });

  it('every added case carries a reviewed flag', () => {
    for (const f of added) {
      for (const c of f.cases) expect(typeof c.reviewed, f.agent).toBe('boolean');
    }
  });

  it('no added case repeats the userText of another line in its file', () => {
    // Pre-growth lines may repeat each other (instrumented variants reuse an input).
    const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
    for (const f of FILES) {
      const all = lines(f.file, f.parse).map((c) => norm(c.userText));
      for (const [i, text] of all.entries()) {
        if (i < f.preGrowth) continue;
        expect(
          all.filter((t) => t === text),
          `${f.agent} line ${String(i + 1)}`,
        ).toHaveLength(1);
      }
    }
  });

  it('added onboarding cases pin asOf on or before the start date', () => {
    const StartDate = z.looseObject({
      createChecklist: z.looseObject({ startDate: z.string() }).optional(),
    });
    const onboarding = lines('onboarding', (v) => OnboardingEvalCase.parse(v)).slice(30);
    for (const line of onboarding) {
      const c = OnboardingEvalCase.parse(line);
      const start = StartDate.parse(c.expected).createChecklist?.startDate;
      if (start === undefined) continue;
      expect(c.asOf, c.id).toBeDefined();
      expect(start >= (c.asOf ?? ''), c.id).toBe(true);
    }
  });

  it('OnboardingEvalCase rejects a malformed asOf', () => {
    const c = {
      id: 'EV-1',
      category: 'extraction',
      actor: { employeeId: 'emp-001', role: 'hr_admin' },
      endpoint: 'messages',
      asOf: '2026-11-02',
      userText: 'Synthetic text',
      expected: {},
      tags: [],
      notes: 'Synthetic note',
    };
    expect(OnboardingEvalCase.safeParse(c).success).toBe(true);
    expect(OnboardingEvalCase.safeParse({ ...c, asOf: 'next Monday' }).success).toBe(false);
  });

  it('added cases hold at least 8 injection cases, at least one per agent', () => {
    const counts = added.map((f) => f.cases.filter((c) => c.category === 'injection').length);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8);
    for (const [i, n] of counts.entries()) expect(n, added[i]?.agent).toBeGreaterThanOrEqual(1);
  });

  it('the eval schemas reject a non-boolean reviewed flag', () => {
    const first = (file: string): Record<string, unknown> => {
      const path = fileURLToPath(new URL(`../../../evals/${file}/cases.jsonl`, import.meta.url));
      return z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(path, 'utf8').split('\n')[0] ?? ''));
    };
    for (const f of FILES) {
      const c = first(f.file);
      expect(() => f.parse(c), f.agent).not.toThrow();
      expect(() => f.parse({ ...c, reviewed: false }), f.agent).not.toThrow();
      expect(() => f.parse({ ...c, reviewed: 'yes' }), f.agent).toThrow();
    }
  });

  it('LeaveEvalCase rejects a malformed asOf or extracted', () => {
    const c = {
      id: 'EV-1',
      category: 'extraction',
      actor: { employeeId: 'emp-004', role: 'employee' },
      asOf: '2026-11-02',
      userText: 'Synthetic text',
      expected: {
        extracted: { leaveType: 'annual', startDate: '2026-11-16', endDate: '2026-11-18' },
      },
      tags: [],
    };
    expect(LeaveEvalCase.safeParse(c).success).toBe(true);
    expect(LeaveEvalCase.safeParse({ ...c, asOf: '02/11/2026' }).success).toBe(false);
    const extracted = { ...c.expected.extracted };
    const withExpected = (e: Record<string, unknown>): unknown => ({
      ...c,
      expected: { extracted: e },
    });
    expect(LeaveEvalCase.safeParse(withExpected({ ...extracted, extra: 1 })).success).toBe(false);
    expect(
      LeaveEvalCase.safeParse(withExpected({ ...extracted, leaveType: 'holiday' })).success,
    ).toBe(false);
  });

  it('added cases hold at least 5 prohibited requests, at least one per agent', () => {
    const counts = added.map((f) => f.cases.filter((c) => c.tags.includes('prohibited')).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
    for (const [i, n] of counts.entries()) expect(n, added[i]?.agent).toBeGreaterThanOrEqual(1);
  });
});
