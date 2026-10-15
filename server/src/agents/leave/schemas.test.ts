import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GetTeamCalendarOutput, LeaveExtraction, RecommendationCard } from './schemas.js';

type Rec = Record<string, unknown>;

const DIR = fileURLToPath(new URL('.', import.meta.url));
function leaveSources(): { file: string; src: string }[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((file) => ({ file, src: readFileSync(`${DIR}${file}`, 'utf8') }));
}

const VALID_EXTRACTION = { leaveType: 'annual', startDate: '2026-11-16', endDate: '2026-11-17' };

const CARD: Rec = {
  requestId: 'req-1',
  employeeId: 'emp-004',
  request: { employeeId: 'emp-004', ...VALID_EXTRACTION },
  today: '2026-10-14',
  verdict: 'ESCALATE_TO_HR',
  ruleResults: [
    {
      ruleId: 'special_type',
      passed: false,
      expected: 'a leave type the manager can decide',
      actual: 'unpaid leave',
      message: 'HR handles unpaid leave requests.',
    },
    {
      ruleId: 'dates_valid',
      passed: true,
      expected: 'real dates',
      actual: '2026-11-16 to 2026-11-17',
      message: 'The dates are valid.',
    },
  ],
  reason: 'Synthetic gate reason',
  policyVersion: 'v1',
  policyHash: '0123456789abcdef'.repeat(4),
  summary: 'Your request needs HR review because it is unpaid leave.',
  summarySource: 'model',
  model: 'claude-sonnet-5-5',
  promptVersion: 'v1',
};

describe('leave agent schemas', () => {
  it('AT-11: GetTeamCalendarOutput rejects extra keys and never strips them', () => {
    const ok = { days: [{ date: '2026-12-08', othersOnLeave: 2 }] };
    expect(GetTeamCalendarOutput.parse(ok)).toEqual(ok);
    const entry = { date: '2026-12-08', othersOnLeave: 2 };
    const bad: Rec[] = [
      { days: [{ ...entry, names: ['Synthetic Person'] }] },
      { days: [{ ...entry, employeeIds: ['emp-007'] }] },
      { days: [{ ...entry, reason: 'Synthetic reason' }] },
      { days: [{ ...entry, leaveType: 'annual' }] },
      { days: [entry], teamSize: 5 },
    ];
    for (const value of bad) {
      const res = GetTeamCalendarOutput.safeParse(value);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
      }
    }
  });

  it('AT-14: LeaveExtraction is strict and never coerces', () => {
    expect(LeaveExtraction.parse(VALID_EXTRACTION)).toEqual(VALID_EXTRACTION);
    for (const extra of [
      { approved: true },
      { verdict: 'ROUTE_TO_MANAGER' },
      { employeeId: 'emp-004' },
    ]) {
      expect(LeaveExtraction.safeParse({ ...VALID_EXTRACTION, ...extra }).success).toBe(false);
    }
    expect(LeaveExtraction.safeParse({ startDate: 20261116 }).success).toBe(false);
  });

  it('AT-15: a missing field stays missing and no default, coerce or transform exists', () => {
    expect(LeaveExtraction.parse({})).toEqual({});
    const sources = leaveSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, src } of sources) {
      expect(src, file).not.toContain('.default(');
      expect(src, file).not.toContain('z.coerce');
      expect(src, file).not.toContain('.transform(');
    }
  });

  it('AT-28: RecommendationCard has no approved, decision or approvedBy key', () => {
    expect(RecommendationCard.safeParse(CARD).success).toBe(true);
    for (const extra of [{ approved: true }, { decision: 'approve' }, { approvedBy: 'emp-001' }]) {
      expect(RecommendationCard.safeParse({ ...CARD, ...extra }).success).toBe(false);
    }
  });
});
