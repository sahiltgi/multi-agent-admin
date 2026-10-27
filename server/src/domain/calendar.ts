// Pure calendar helpers for ISO `YYYY-MM-DD` dates (spec domain-schemas D-5, D-7).
// No clock and no I/O: callers always pass the dates in.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEAVE_PERIOD = /^(\d{4})-(\d{2})$/;

function dateParts(s: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(s);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** True for a `YYYY-MM-DD` string naming a day that exists, leap years included. */
export function isRealCalendarDate(s: string): boolean {
  const parts = dateParts(s);
  if (parts === null) return false;
  const { year, month, day } = parts;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** True when a real calendar date falls Monday to Friday. */
export function isWeekday(date: string): boolean {
  const parts = dateParts(date);
  if (parts === null || !isRealCalendarDate(date)) return false;
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

/** True when `date` is inside leave period `YYYY-YY`: 1 April of the first year to 31 March of the next, inclusive. */
export function isInLeavePeriod(date: string, period: string): boolean {
  const match = LEAVE_PERIOD.exec(period);
  if (match === null || !isRealCalendarDate(date)) return false;
  const startYear = Number(match[1]);
  return date >= `${String(startYear)}-04-01` && date <= `${String(startYear + 1)}-03-31`;
}

// ---- Working days (spec approval-queue-ui rule 18; leave-gate rule 9, D-1, D-8) ----
// A day number counts days since 1970-01-01, so ranges are counted without stepping through
// every day.

const MS_PER_DAY = 86_400_000;

function toDayNumber(date: string): number {
  const d = new Date(0);
  // setUTCFullYear, unlike Date.UTC, keeps years 0–99 as written.
  d.setUTCFullYear(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return Math.round(d.getTime() / MS_PER_DAY);
}

/** Monday to Friday. Day 0 (1970-01-01) was a Thursday. */
function isWeekdayNumber(day: number): boolean {
  const dow = (((day + 4) % 7) + 7) % 7; // 0 = Sunday
  return dow >= 1 && dow <= 5;
}

export interface WorkingDaySpan {
  startDate: string;
  endDate: string;
  startHalf?: 'pm'; // leave starts at noon on startDate
  endHalf?: 'am'; // leave ends at noon on endDate
}

/**
 * Working days in [startDate, endDate]: Monday to Friday, minus weekday holidays (a weekend
 * holiday or a duplicate is never subtracted twice). A half-day marker subtracts 0.5 only on a
 * working day. Throws RangeError for a date that isn't real or an end before the start.
 */
export function countWorkingDays(span: WorkingDaySpan, holidayDates: readonly string[]): number {
  const { startDate, endDate } = span;
  if (!isRealCalendarDate(startDate) || !isRealCalendarDate(endDate)) {
    throw new RangeError('dates must be real YYYY-MM-DD calendar dates');
  }
  if (endDate < startDate) throw new RangeError('endDate is before startDate');

  const from = toDayNumber(startDate);
  const to = toDayNumber(endDate) + 1; // half-open [from, to)
  const holidays = new Set(holidayDates.map(toDayNumber).filter(isWeekdayNumber));
  const isWorkingDay = (day: number): boolean => isWeekdayNumber(day) && !holidays.has(day);

  const fullWeeks = Math.floor((to - from) / 7);
  let weekdays = fullWeeks * 5;
  for (let d = from + fullWeeks * 7; d < to; d++) if (isWeekdayNumber(d)) weekdays++;
  let holidaysInRange = 0;
  for (const h of holidays) if (h >= from && h < to) holidaysInRange++;

  let amount = weekdays - holidaysInRange;
  if (span.startHalf !== undefined && isWorkingDay(from)) amount -= 0.5;
  if (span.endHalf !== undefined && isWorkingDay(to - 1)) amount -= 0.5;
  return amount;
}
