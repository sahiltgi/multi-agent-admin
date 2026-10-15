import { describe, expect, it } from 'vitest';
import { isInLeavePeriod, isRealCalendarDate, isWeekday } from './calendar.js';

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
