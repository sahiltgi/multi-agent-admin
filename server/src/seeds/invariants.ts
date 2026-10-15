// Seed invariants (spec domain-schemas, rules 17–22). Pure: returns one readable message
// per violation, and an empty array when the fixtures are valid.
import { isInLeavePeriod, isWeekday } from '../domain/calendar.js';
import { LEAVE_TYPES, type Employee } from '../domain/schemas.js';
import type { SeedFixtures } from './fixtures.js';

const PERIOD = '2026-27';
const TEAM_COUNT = 3;
const EMPLOYEE_COUNT = 20;
const OVERLAP_TEAM = 'team-a';
const MIN_OVERLAPPING_LEAVES = 2;
const DAY_MS = 86_400_000;

// Rule 18 layout: the stable ids that x-demo-user, Playwright and the EV cases rely on.
const HR_ADMIN_ID = 'emp-001';
function empRange(from: number, to: number): string[] {
  const ids: string[] = [];
  for (let n = from; n <= to; n += 1) ids.push(`emp-${String(n).padStart(3, '0')}`);
  return ids;
}
const TEAM_LAYOUT: Readonly<Record<string, { manager: string; members: readonly string[] }>> = {
  'team-a': { manager: 'emp-002', members: empRange(3, 8) },
  'team-b': { manager: 'emp-009', members: empRange(10, 14) },
  'team-c': { manager: 'emp-015', members: empRange(16, 20) },
};

function dayNumber(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function isoFromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Day numbers from start to end inclusive that are Mon–Fri and not a holiday. */
function workingDays(start: string, end: string, holidayDates: ReadonlySet<string>): Set<number> {
  const days = new Set<number>();
  for (let n = dayNumber(start); n <= dayNumber(end); n += 1) {
    const iso = isoFromDayNumber(n);
    if (isWeekday(iso) && !holidayDates.has(iso)) days.add(n);
  }
  return days;
}

function checkSynthetic(f: SeedFixtures, out: string[]): void {
  for (const e of f.employees) {
    if (!/^emp-\d{3}$/.test(e.id)) out.push(`employee ${e.id}: id must match emp-NNN`);
    if (!e.email.endsWith('.example'))
      out.push(`employee ${e.id}: email must use the .example domain`);
  }
  for (const t of f.teams) {
    if (!/^team-[a-c]$/.test(t.id)) out.push(`team ${t.id}: id must match team-[a-c]`);
  }
  for (const r of f.leaveRequests) {
    if (!/^lr-\d{3}$/.test(r.id)) out.push(`leave request ${r.id}: id must match lr-NNN`);
  }
}

function checkOrganisation(
  f: SeedFixtures,
  byId: ReadonlyMap<string, Employee>,
  out: string[],
): void {
  if (f.teams.length !== TEAM_COUNT)
    out.push(`expected ${String(TEAM_COUNT)} teams, found ${String(f.teams.length)}`);
  if (new Set(f.teams.map((t) => t.id)).size !== f.teams.length)
    out.push('team ids must be unique');
  if (f.employees.length !== EMPLOYEE_COUNT) {
    out.push(`expected ${String(EMPLOYEE_COUNT)} employees, found ${String(f.employees.length)}`);
  }
  if (byId.size !== f.employees.length) out.push('employee ids must be unique');

  const admins = f.employees.filter((e) => e.role === 'hr_admin');
  if (admins.length !== 1)
    out.push(`expected exactly one hr_admin, found ${String(admins.length)}`);
  if (byId.get(HR_ADMIN_ID)?.role !== 'hr_admin') out.push(`${HR_ADMIN_ID} must be the hr_admin`);

  for (const [teamId, layout] of Object.entries(TEAM_LAYOUT)) {
    if (f.teams.find((t) => t.id === teamId)?.managerId !== layout.manager) {
      out.push(`team ${teamId}: manager must be ${layout.manager}`);
    }
    for (const id of [layout.manager, ...layout.members]) {
      if (byId.get(id)?.teamId !== teamId) out.push(`employee ${id}: must be in ${teamId}`);
    }
  }

  const teamManager = new Map(f.teams.map((t) => [t.id, t.managerId]));
  for (const t of f.teams) {
    const manager = byId.get(t.managerId);
    if (manager?.role !== 'manager' || manager.teamId !== t.id) {
      out.push(`team ${t.id}: managerId must be a manager in that team`);
    }
    const managers = f.employees.filter((e) => e.role === 'manager' && e.teamId === t.id);
    if (managers.length !== 1)
      out.push(`team ${t.id}: expected one manager, found ${String(managers.length)}`);
  }

  for (const e of f.employees) {
    if (e.role === 'hr_admin') {
      if (e.teamId !== null || e.managerId !== null) {
        out.push(`employee ${e.id}: the hr_admin has no team and no manager`);
      }
      continue;
    }
    if (e.teamId === null || !teamManager.has(e.teamId)) {
      out.push(`employee ${e.id}: teamId must name an existing team`);
    }
    const manager = e.managerId === null ? undefined : byId.get(e.managerId);
    if (e.role === 'manager' && manager?.role !== 'hr_admin') {
      out.push(`employee ${e.id}: a manager's managerId must be the hr_admin`);
    }
    if (e.role === 'employee') {
      if (manager?.role !== 'manager' || e.managerId !== teamManager.get(e.teamId ?? '')) {
        out.push(`employee ${e.id}: managerId must be the manager of their team`);
      }
    }
  }

  for (const e of f.employees) {
    const seen = new Set<string>();
    let current: string | null = e.id;
    while (current !== null) {
      if (seen.has(current)) {
        out.push(`employee ${e.id}: managerId chain has a cycle`);
        break;
      }
      seen.add(current);
      current = byId.get(current)?.managerId ?? null;
    }
  }
}

function checkBalances(f: SeedFixtures, byId: ReadonlyMap<string, Employee>, out: string[]): void {
  const counts = new Map<string, number>();
  for (const b of f.leaveBalances) {
    if (!byId.has(b.employeeId)) out.push(`balance for unknown employee ${b.employeeId}`);
    if (b.period !== PERIOD)
      out.push(`balance ${b.employeeId}/${b.leaveType}: period must be ${PERIOD}`);
    const key = `${b.employeeId}/${b.leaveType}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const e of f.employees) {
    for (const t of LEAVE_TYPES) {
      const n = counts.get(`${e.id}/${t}`) ?? 0;
      if (n !== 1)
        out.push(`employee ${e.id}: expected one ${t} balance for ${PERIOD}, found ${String(n)}`);
    }
  }
}

function checkHolidays(f: SeedFixtures, out: string[]): void {
  const dates = f.holidays.map((h) => h.date);
  for (const h of f.holidays) {
    if (h.period !== PERIOD || !isInLeavePeriod(h.date, PERIOD)) {
      out.push(`holiday ${h.date}: must fall inside ${PERIOD}`);
    }
  }
  if (new Set(dates).size !== dates.length) out.push('holiday dates must be unique');
  if (!dates.some((d) => isWeekday(d))) out.push('at least one holiday must fall on a weekday');
  if (!dates.some((d) => !isWeekday(d))) out.push('at least one holiday must fall on a weekend');
}

function checkLeaves(f: SeedFixtures, byId: ReadonlyMap<string, Employee>, out: string[]): void {
  const approved = f.leaveRequests.filter((r) => r.status === 'approved');
  if (approved.length === 0) out.push('expected approved leave requests');
  for (const r of approved) {
    if (!isInLeavePeriod(r.startDate, PERIOD) || !isInLeavePeriod(r.endDate, PERIOD)) {
      out.push(`leave request ${r.id}: must fall inside ${PERIOD}`);
    }
  }
  for (const r of f.leaveRequests) {
    if (!byId.has(r.employeeId))
      out.push(`leave request ${r.id}: unknown employee ${r.employeeId}`);
  }

  // Rule 22: some working day is shared by approved leaves of enough different team-a members.
  const holidayDates = new Set(f.holidays.map((h) => h.date));
  const membersByDay = new Map<number, Set<string>>();
  for (const r of approved) {
    if (byId.get(r.employeeId)?.teamId !== OVERLAP_TEAM) continue;
    for (const day of workingDays(r.startDate, r.endDate, holidayDates)) {
      const members = membersByDay.get(day) ?? new Set<string>();
      members.add(r.employeeId);
      membersByDay.set(day, members);
    }
  }
  const maxOverlap = Math.max(0, ...[...membersByDay.values()].map((m) => m.size));
  if (maxOverlap < MIN_OVERLAPPING_LEAVES) {
    out.push(
      `${OVERLAP_TEAM}: expected ${String(MIN_OVERLAPPING_LEAVES)} members on approved leave on a shared working day`,
    );
  }
}

export function checkSeedInvariants(fixtures: SeedFixtures): string[] {
  const out: string[] = [];
  const byId = new Map(fixtures.employees.map((e) => [e.id, e]));
  checkSynthetic(fixtures, out);
  checkOrganisation(fixtures, byId, out);
  checkBalances(fixtures, byId, out);
  checkHolidays(fixtures, out);
  checkLeaves(fixtures, byId, out);
  return out;
}
