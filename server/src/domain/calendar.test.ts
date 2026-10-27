import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoadedLeavePolicy } from '../gate/leave-policy.schema.js';
import { evaluateLeave } from '../gate/leave.js';
import { countWorkingDays, isInLeavePeriod, isRealCalendarDate, isWeekday } from './calendar.js';

// ---- approval-queue-ui AT-19 (rule 18): the shared, pure working-day count ----
interface Row {
  start: string;
  end: string;
  startHalf?: 'pm';
  endHalf?: 'am';
  holidays: string[];
  result: number | 'throws';
}
const ROWS: Row[] = [
  { start: '2026-11-16', end: '2026-11-17', holidays: [], result: 2 },
  { start: '2026-11-16', end: '2026-11-17', startHalf: 'pm', holidays: [], result: 1.5 },
  { start: '2026-11-16', end: '2026-11-16', endHalf: 'am', holidays: [], result: 0.5 },
  { start: '2026-11-20', end: '2026-11-23', holidays: [], result: 2 },
  { start: '2026-11-21', end: '2026-11-23', startHalf: 'pm', holidays: [], result: 1 },
  { start: '2026-11-20', end: '2026-11-22', endHalf: 'am', holidays: [], result: 1 },
  { start: '2026-11-16', end: '2026-11-18', holidays: ['2026-11-17'], result: 2 },
  { start: '2026-11-16', end: '2026-11-18', holidays: ['2026-11-17', '2026-11-17'], result: 2 },
  { start: '2026-11-20', end: '2026-11-23', holidays: ['2026-11-21'], result: 2 },
  { start: '2026-11-17', end: '2026-11-17', startHalf: 'pm', holidays: ['2026-11-17'], result: 0 },
  { start: '2026-11-21', end: '2026-11-22', holidays: [], result: 0 },
  { start: '2026-11-16', end: '2026-11-27', holidays: ['2026-12-25'], result: 10 },
  { start: '2026-11-17', end: '2026-11-16', holidays: [], result: 'throws' },
  { start: '2026-02-30', end: '2026-03-02', holidays: [], result: 'throws' },
];
const span = (r: Row) => ({
  startDate: r.start,
  endDate: r.end,
  ...(r.startHalf === undefined ? {} : { startHalf: r.startHalf }),
  ...(r.endHalf === undefined ? {} : { endHalf: r.endHalf }),
});

function gatePolicy(): LoadedLeavePolicy {
  return LoadedLeavePolicy.parse({
    policy: {
      version: 'v1',
      effectiveFrom: '2026-10-01',
      leaveTypes: ['annual', 'sick', 'casual', 'unpaid', 'bereavement', 'parental'],
      minNoticeWorkingDays: {
        annual: 0,
        sick: 0,
        casual: 0,
        unpaid: 0,
        bereavement: 0,
        parental: 0,
      },
      requiredFields: {
        annual: ['startDate', 'endDate'],
        sick: ['startDate', 'endDate'],
        casual: ['startDate', 'endDate'],
        unpaid: ['startDate', 'endDate', 'reason'],
        bereavement: ['startDate', 'endDate'],
        parental: ['startDate', 'endDate'],
      },
      alwaysEscalate: ['unpaid', 'bereavement', 'parental'],
      blackoutWindows: [],
      maxTeamOverlapPercent: 30,
      escalateAboveConsecutiveWorkingDays: 10,
    },
    policyVersion: 'v1',
    policyHash: 'a'.repeat(64),
  });
}

describe('countWorkingDays (approval-queue-ui rule 18)', () => {
  it.each(ROWS.map((r) => [`${r.start}..${r.end}`, r] as const))(
    'AT-19: %s gives the table result',
    (_name, r) => {
      if (r.result === 'throws') {
        expect(() => countWorkingDays(span(r), r.holidays)).toThrow(RangeError);
      } else {
        expect(countWorkingDays(span(r), r.holidays)).toBe(r.result);
        expect(countWorkingDays(span(r), r.holidays)).toBe(r.result); // deterministic
      }
    },
  );

  it('AT-19: gate leave.ts delegates to countWorkingDays and declares no private count', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'gate', 'leave.ts'), 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*\bcountWorkingDays\b[^}]*\}\s*from\s*'\.\.\/domain\/calendar\.js'/,
    );
    expect(src).not.toContain('countBetween');
    expect(src).not.toContain('workingDayAmount');
  });

  it('AT-19: calendar.ts reads no clock, randomness or process', () => {
    const src = readFileSync(join(import.meta.dirname, 'calendar.ts'), 'utf8');
    expect(src).not.toContain('Date.now');
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(src).not.toContain('Math.random');
    expect(src).not.toContain('process');
  });

  it('AT-19: evaluateLeave names the same number in dates_valid for each positive row', () => {
    const rows = ROWS.filter((r) => typeof r.result === 'number' && r.result > 0);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const res = evaluateLeave(
        {
          employeeId: 'emp-003',
          leaveType: 'annual',
          startDate: r.start,
          endDate: r.end,
          ...(r.startHalf === undefined ? {} : { startHalf: r.startHalf }),
          ...(r.endHalf === undefined ? {} : { endHalf: r.endHalf }),
        },
        {
          employeeId: 'emp-003',
          balances: [
            {
              employeeId: 'emp-003',
              leaveType: 'annual',
              period: '2026-27',
              entitledDays: 20,
              usedDays: 0,
            },
          ],
          holidays: r.holidays,
          teamSize: 10,
          teamCalendar: [],
        },
        gatePolicy(),
        '2026-10-14',
      );
      const dv = res.ruleResults.find((x) => x.ruleId === 'dates_valid');
      expect(dv?.message, `${r.start}..${r.end}`).toMatch(
        new RegExp(`\\b${String(r.result).replace('.', '\\.')} working day`),
      );
    }
  });
});

describe('calendar', () => {
  it('AT-27: isInLeavePeriod covers 1 April to 31 March inclusive', () => {
    expect(isInLeavePeriod('2026-04-01', '2026-27')).toBe(true);
    expect(isInLeavePeriod('2027-03-31', '2026-27')).toBe(true);
    expect(isInLeavePeriod('2026-03-31', '2026-27')).toBe(false);
    expect(isInLeavePeriod('2027-04-01', '2026-27')).toBe(false);
  });

  it('AT-32: isRealCalendarDate respects leap years and month ranges', () => {
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    expect(isRealCalendarDate('2027-02-29')).toBe(false);
    expect(isRealCalendarDate('2026-13-01')).toBe(false);
  });

  it('AT-27: isWeekday is true Monday to Friday only', () => {
    expect(isWeekday('2026-11-16')).toBe(true); // Monday
    expect(isWeekday('2026-11-20')).toBe(true); // Friday
    expect(isWeekday('2026-11-14')).toBe(false); // Saturday
    expect(isWeekday('2026-11-15')).toBe(false); // Sunday
  });
});
