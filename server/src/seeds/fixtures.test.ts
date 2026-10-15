import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isInLeavePeriod, isWeekday } from '../domain/calendar.js';
import { ENTITY_SCHEMAS, LEAVE_TYPES, type Employee, type Holiday } from '../domain/schemas.js';
import { COMPANY_NAME, fixtures, type SeedFixtures } from './fixtures.js';
import { checkSeedInvariants } from './invariants.js';

const PERIOD = '2026-27';
const seedsDir = fileURLToPath(new URL('.', import.meta.url));

function clone(): SeedFixtures {
  return structuredClone(fixtures);
}

function findEmployee(employees: readonly Employee[], id: string): Employee {
  const found = employees.find((e) => e.id === id);
  if (!found) throw new Error(`missing employee ${id}`);
  return found;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

function workingDays(start: string, end: string, holidays: readonly Holiday[]): Set<number> {
  const holidayDays = new Set(holidays.map((h) => dayNumber(h.date)));
  const result = new Set<number>();
  for (let n = dayNumber(start); n <= dayNumber(end); n += 1) {
    const iso = new Date(n * 86_400_000).toISOString().slice(0, 10);
    if (isWeekday(iso) && !holidayDays.has(n)) result.add(n);
  }
  return result;
}

describe('seed fixtures', () => {
  it('AT-18: every record parses with its schema and invariants hold', () => {
    for (const r of fixtures.teams) expect(ENTITY_SCHEMAS.Team.safeParse(r).success).toBe(true);
    for (const r of fixtures.employees) {
      expect(ENTITY_SCHEMAS.Employee.safeParse(r).success).toBe(true);
    }
    for (const r of fixtures.leaveBalances) {
      expect(ENTITY_SCHEMAS.LeaveBalance.safeParse(r).success).toBe(true);
    }
    for (const r of fixtures.holidays) {
      expect(ENTITY_SCHEMAS.Holiday.safeParse(r).success).toBe(true);
    }
    for (const r of fixtures.leaveRequests) {
      expect(ENTITY_SCHEMAS.LeaveRequest.safeParse(r).success).toBe(true);
    }
    expect(checkSeedInvariants(fixtures)).toEqual([]);
  });

  it('AT-22: fixtures are deterministic across module reloads', async () => {
    const first = await import('./fixtures.js');
    const snapshot = structuredClone(first.fixtures);
    vi.resetModules();
    const second = await import('./fixtures.js');
    expect(second.fixtures).toEqual(snapshot);
    expect(second.COMPANY_NAME).toBe(first.COMPANY_NAME);
  });

  it('AT-22: seed sources have no randomness, clock or faker, and README says synthetic only', () => {
    const files = readdirSync(seedsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files).toContain('fixtures.ts');
    for (const file of files) {
      const text = readFileSync(`${seedsDir}${file}`, 'utf8');
      expect(text, file).not.toMatch(/Math\.random/);
      expect(text, file).not.toMatch(/Date\.now/);
      expect(text, file).not.toMatch(/new Date\(\s*\)/);
      expect(text, file).not.toMatch(/faker/i);
    }
    const readme = readFileSync(`${seedsDir}README.md`, 'utf8');
    expect(readme).toContain('synthetic only');
  });

  it('AT-23: ids, emails and company name are synthetic', () => {
    expect(COMPANY_NAME).toBe('Example Widgets Demo Co.');
    for (const e of fixtures.employees) {
      expect(e.email.endsWith('.example')).toBe(true);
      expect(e.id).toMatch(/^emp-\d{3}$/);
    }
    for (const t of fixtures.teams) expect(t.id).toMatch(/^team-[a-c]$/);
    for (const r of fixtures.leaveRequests) expect(r.id).toMatch(/^lr-\d{3}$/);
  });

  it('AT-24: 3 teams, 20 employees, one hr_admin emp-001, team managers valid', () => {
    expect(fixtures.teams.map((t) => t.id).sort()).toEqual(['team-a', 'team-b', 'team-c']);
    expect(fixtures.employees).toHaveLength(20);
    const admins = fixtures.employees.filter((e) => e.role === 'hr_admin');
    expect(admins.map((a) => a.id)).toEqual(['emp-001']);
    for (const t of fixtures.teams) {
      const m = findEmployee(fixtures.employees, t.managerId);
      expect(m.role).toBe('manager');
      expect(m.teamId).toBe(t.id);
    }
    const bad = clone();
    bad.employees = bad.employees.map((e) =>
      e.id === 'emp-005' ? { ...e, role: 'hr_admin' as const } : e,
    );
    expect(checkSeedInvariants(bad).length).toBeGreaterThanOrEqual(1);
  });

  it('AT-24: invariants enforce the rule 18 layout (team-a stays at 7 people)', () => {
    const moved = clone();
    moved.employees = moved.employees.map((e) =>
      e.id === 'emp-004' ? { ...e, teamId: 'team-b', managerId: 'emp-009' } : e,
    );
    expect(checkSeedInvariants(moved).some((m) => m.includes('emp-004'))).toBe(true);
  });

  it('AT-24: invariants require the hr_admin to be emp-001', () => {
    const renamed = clone();
    renamed.employees = renamed.employees.map((e) => {
      if (e.id === 'emp-001')
        return { ...e, id: 'emp-099', email: 'emp-099@example-widgets.example' };
      if (e.managerId === 'emp-001') return { ...e, managerId: 'emp-099' };
      return e;
    });
    renamed.leaveBalances = renamed.leaveBalances.map((b) =>
      b.employeeId === 'emp-001' ? { ...b, employeeId: 'emp-099' } : b,
    );
    expect(checkSeedInvariants(renamed).some((m) => m.includes('emp-001'))).toBe(true);
  });

  it('AT-25: management chain is valid and acyclic', () => {
    const byId = new Map(fixtures.employees.map((e) => [e.id, e]));
    const teamManager = new Map(fixtures.teams.map((t) => [t.id, t.managerId]));
    for (const e of fixtures.employees) {
      if (e.role === 'employee') {
        expect(e.teamId).not.toBeNull();
        expect(e.managerId).toBe(teamManager.get(e.teamId ?? ''));
        expect(byId.get(e.managerId ?? '')?.role).toBe('manager');
      } else if (e.role === 'manager') {
        expect(byId.get(e.managerId ?? '')?.role).toBe('hr_admin');
      } else {
        expect(e.managerId).toBeNull();
        expect(e.teamId).toBeNull();
      }
      const seen = new Set<string>();
      let cur: string | null = e.id;
      while (cur !== null) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = byId.get(cur)?.managerId ?? null;
      }
    }
    const bad = clone();
    bad.employees = bad.employees.map((e) =>
      e.id === 'emp-002' ? { ...e, role: 'employee' as const } : e,
    );
    expect(checkSeedInvariants(bad).length).toBeGreaterThanOrEqual(1);
  });

  it('AT-26: one balance per employee per leave type for 2026-27 (120 total)', () => {
    expect(fixtures.leaveBalances).toHaveLength(120);
    for (const e of fixtures.employees) {
      for (const t of LEAVE_TYPES) {
        const matches = fixtures.leaveBalances.filter(
          (b) => b.employeeId === e.id && b.leaveType === t && b.period === PERIOD,
        );
        expect(matches, `${e.id}/${t}`).toHaveLength(1);
      }
    }
  });

  it('AT-27: holidays are in period, unique, include a weekday and a weekend day', () => {
    const dates = fixtures.holidays.map((h) => h.date);
    for (const d of dates) expect(isInLeavePeriod(d, PERIOD)).toBe(true);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.some((d) => isWeekday(d))).toBe(true);
    expect(dates.some((d) => !isWeekday(d))).toBe(true);
    const bad = clone();
    const first = bad.holidays[0];
    if (!first) throw new Error('no holidays');
    bad.holidays = [...bad.holidays, { ...first, name: 'Duplicate Day' }];
    expect(checkSeedInvariants(bad).length).toBeGreaterThanOrEqual(1);
  });

  it('AT-28: approved leaves are in period and two team-a members overlap on a working day', () => {
    const approved = fixtures.leaveRequests.filter((r) => r.status === 'approved');
    expect(approved.length).toBeGreaterThanOrEqual(2);
    for (const r of approved) {
      expect(isInLeavePeriod(r.startDate, PERIOD)).toBe(true);
      expect(isInLeavePeriod(r.endDate, PERIOD)).toBe(true);
    }
    const teamA = approved.filter(
      (r) => findEmployee(fixtures.employees, r.employeeId).teamId === 'team-a',
    );
    let overlap = false;
    for (let i = 0; i < teamA.length; i += 1) {
      for (let j = i + 1; j < teamA.length; j += 1) {
        const a = teamA[i];
        const b = teamA[j];
        if (!a || !b || a.employeeId === b.employeeId) continue;
        const daysA = workingDays(a.startDate, a.endDate, fixtures.holidays);
        const daysB = workingDays(b.startDate, b.endDate, fixtures.holidays);
        if ([...daysA].some((d) => daysB.has(d))) overlap = true;
      }
    }
    expect(overlap).toBe(true);
  });
});
