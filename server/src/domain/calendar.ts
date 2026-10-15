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
