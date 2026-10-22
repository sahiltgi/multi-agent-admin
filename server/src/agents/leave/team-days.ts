// Team-day counting shared by the leave data ports (spec mongo-persistence D-14; leave-agent D-10;
// leave-gate D-11). Pure: callers pass the teammates' counted requests, never the requester's.
import type { TeamDayCount } from '../../gate/leave.js';
import type { LeaveRequest } from '../../domain/schemas.js';
import type { DateRange } from './schemas.js';

/** Statuses that count as away in othersOnLeave (mongo-persistence D-14). */
export const COUNTED_STATUSES = ['approved', 'pending_approval'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Per calendar date in `range`, the number of distinct employees with a request covering it. A
 * half day counts on its date. Dates with zero are omitted, one entry per date, ascending.
 */
export function countTeamDays(
  leaves: readonly Pick<LeaveRequest, 'employeeId' | 'startDate' | 'endDate'>[],
  range: DateRange,
): TeamDayCount[] {
  const from = dayMs(range.from);
  const to = dayMs(range.to);
  const away = new Map<number, Set<string>>();
  for (const leave of leaves) {
    const start = Math.max(dayMs(leave.startDate), from);
    const end = Math.min(dayMs(leave.endDate), to);
    for (let t = start; t <= end; t += DAY_MS) {
      const who = away.get(t) ?? new Set<string>();
      who.add(leave.employeeId);
      away.set(t, who);
    }
  }
  return [...away.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, who]) => ({ date: isoDay(t), othersOnLeave: who.size }));
}
