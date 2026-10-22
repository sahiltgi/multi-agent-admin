// In-memory LeaveDataPort over the seed fixtures (spec eval-runner, rule 7; D-2). It must give the
// same answers as the Mongo port: counted statuses, distinct teammates, requester excluded.
import { describe, expect, it } from 'vitest';
import type { Employee, LeaveRequest } from '../../domain/schemas.js';
import { fixtures } from '../../seeds/fixtures.js';
import { InMemoryLeaveDataPort } from './in-memory-port.js';
import { COUNTED_STATUSES, countTeamDays } from './team-days.js';

const DEC = { from: '2026-12-01', to: '2026-12-31' };

describe('countTeamDays', () => {
  it('counts distinct people per date, clipped to the range, ascending', () => {
    const leaves = [
      { employeeId: 'emp-005', startDate: '2026-11-30', endDate: '2026-12-02' },
      { employeeId: 'emp-006', startDate: '2026-12-02', endDate: '2026-12-02' },
      { employeeId: 'emp-006', startDate: '2026-12-02', endDate: '2026-12-03' },
    ];
    expect(countTeamDays(leaves, DEC)).toEqual([
      { date: '2026-12-01', othersOnLeave: 1 },
      { date: '2026-12-02', othersOnLeave: 2 },
      { date: '2026-12-03', othersOnLeave: 1 },
    ]);
  });

  it('counts approved and pending requests only', () => {
    expect([...COUNTED_STATUSES]).toEqual(['approved', 'pending_approval']);
  });
});

describe('InMemoryLeaveDataPort', () => {
  const port = new InMemoryLeaveDataPort(fixtures);

  it('returns only the requester balances', async () => {
    const balances = (await port.getBalances('emp-004')) as { employeeId: string }[];
    expect(balances.length).toBeGreaterThan(0);
    expect(balances.every((b) => b.employeeId === 'emp-004')).toBe(true);
  });

  it('returns holidays inside the range, both ends inclusive', async () => {
    const holidays = (await port.getHolidays({ from: '2026-11-18', to: '2026-12-25' })) as {
      date: string;
    }[];
    expect(holidays.map((h) => h.date)).toEqual(['2026-11-18', '2026-12-25']);
  });

  it('counts the seeded team-a overlap and excludes the requester', async () => {
    const days = await port.getTeamDayCounts('emp-004', DEC);
    expect(days).toEqual([
      { date: '2026-12-07', othersOnLeave: 1 },
      { date: '2026-12-08', othersOnLeave: 2 },
      { date: '2026-12-09', othersOnLeave: 2 },
      { date: '2026-12-10', othersOnLeave: 1 },
    ]);
    const own = await port.getTeamDayCounts('emp-005', DEC);
    expect(own).toContainEqual({ date: '2026-12-08', othersOnLeave: 1 });
  });

  it('ignores statuses that are not counted', async () => {
    const rejected: LeaveRequest = {
      id: 'lr-900',
      employeeId: 'emp-003',
      leaveType: 'annual',
      startDate: '2026-12-14',
      endDate: '2026-12-14',
      status: 'rejected',
      createdAt: '2026-11-01T09:00:00Z',
    };
    const p = new InMemoryLeaveDataPort({ ...fixtures, leaveRequests: [rejected] });
    expect(await p.getTeamDayCounts('emp-004', DEC)).toEqual([]);
  });

  it('gives team size including the requester, 1 with no team, and rejects unknown ids', async () => {
    expect(await port.getTeamSize('emp-004')).toBe(7);
    expect(await port.getTeamSize('emp-001')).toBe(1);
    expect(await port.getTeamDayCounts('emp-001', DEC)).toEqual([]);
    await expect(port.getTeamSize('emp-999')).rejects.toThrow('unknown employee');
  });

  it('never hands out the seed objects it holds', async () => {
    const employees: Employee[] = structuredClone(fixtures.employees);
    const p = new InMemoryLeaveDataPort({ ...fixtures, employees });
    const balances = (await p.getBalances('emp-004')) as { usedDays: number }[];
    const first = balances[0];
    if (first === undefined) throw new Error('no balance');
    first.usedDays = 99;
    const again = (await p.getBalances('emp-004')) as { usedDays: number }[];
    expect(again[0]?.usedDays).not.toBe(99);
  });
});
