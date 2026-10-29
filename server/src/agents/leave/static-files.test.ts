import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateLeave, type LeaveGateContext, type TeamDayCount } from '../../gate/leave.js';
import { loadLeavePolicy } from '../../policies/load.js';
import { fixtures } from '../../seeds/fixtures.js';
import { LeaveEvalCase } from './schemas.js';
import { COUNTED_STATUSES } from './team-days.js';

const CASES = fileURLToPath(new URL('../../../../evals/leave/cases.jsonl', import.meta.url));
const POLICY = fileURLToPath(new URL('../../../../policies/leave/v1.yaml', import.meta.url));

function cases(): LeaveEvalCase[] {
  return readFileSync(CASES, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => LeaveEvalCase.parse(JSON.parse(line)));
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

const COUNTED = new Set<string>(COUNTED_STATUSES);

/**
 * The seeded context `submit_to_gate` would load, as the Mongo port builds it: per date, the
 * distinct team-mates (requester excluded) with a counted request covering it. A requester with
 * no team has team size 1 and an empty calendar.
 */
function seedContext(employeeId: string): LeaveGateContext {
  const me = fixtures.employees.find((e) => e.id === employeeId);
  if (me === undefined) throw new Error(`${employeeId} is not seeded`);
  const teamId = me.teamId;
  const team = new Set(
    teamId === null
      ? [employeeId]
      : fixtures.employees.filter((e) => e.teamId === teamId).map((e) => e.id),
  );
  const away = new Map<string, Set<string>>();
  for (const r of fixtures.leaveRequests) {
    if (!COUNTED.has(r.status) || r.employeeId === employeeId || !team.has(r.employeeId)) continue;
    for (let d = r.startDate; d <= r.endDate; d = nextDay(d))
      away.set(d, (away.get(d) ?? new Set()).add(r.employeeId));
  }
  const teamCalendar: TeamDayCount[] = [...away].map(([date, who]) => ({
    date,
    othersOnLeave: who.size,
  }));
  return {
    employeeId,
    balances: fixtures.leaveBalances.filter((b) => b.employeeId === employeeId),
    holidays: fixtures.holidays.map((h) => h.date),
    teamSize: team.size,
    teamCalendar,
  };
}

describe('leave static files', () => {
  it('D-4: evals/leave/cases.jsonl parses as LeaveEvalCase with ids exactly EV-1 to EV-48 (chat-endpoint amendment: EV-22 to EV-31; eval growth: EV-32 to EV-40; red team: EV-41 to EV-48)', () => {
    expect(existsSync(CASES)).toBe(true);
    const ids = cases().map((c) => c.id);
    const expected = Array.from({ length: 48 }, (_, i) => `EV-${String(i + 1)}`);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('eval growth: every case with extracted fields pins asOf, and the real gate gives its expected verdict', () => {
    const policy = loadLeavePolicy(POLICY);
    const labelled = cases().filter((c) => c.expected.extracted !== undefined);
    expect(labelled.length).toBeGreaterThan(0);
    for (const c of labelled) {
      expect(c.asOf, c.id).toBeDefined();
      if (c.expected.verdict === undefined) continue;
      const request = { employeeId: c.actor.employeeId, ...c.expected.extracted };
      const gate = evaluateLeave(request, seedContext(c.actor.employeeId), policy, c.asOf);
      expect(gate.verdict, c.id).toBe(c.expected.verdict);
    }
  });
});
