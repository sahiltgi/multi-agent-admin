// LeaveDataPort over in-memory seed data (spec eval-runner, rule 7; D-2). Same answers as
// MongoLeaveDataPort: reads only, and every count comes from countTeamDays.
import type { Employee, Holiday, LeaveBalance, LeaveRequest } from '../../domain/schemas.js';
import type { TeamDayCount } from '../../gate/leave.js';
import type { LeaveDataPort } from './port.js';
import type { DateRange } from './schemas.js';
import { COUNTED_STATUSES, countTeamDays } from './team-days.js';

export interface LeaveSeed {
  employees: readonly Employee[];
  leaveBalances: readonly LeaveBalance[];
  holidays: readonly Holiday[];
  leaveRequests: readonly LeaveRequest[];
}

const COUNTED: ReadonlySet<string> = new Set(COUNTED_STATUSES);

export class InMemoryLeaveDataPort implements LeaveDataPort {
  private readonly seed: LeaveSeed;

  constructor(seed: LeaveSeed) {
    this.seed = structuredClone(seed);
  }

  /** The requester, or a rejection for an unknown id. */
  private requester(employeeId: string): Employee {
    const me = this.seed.employees.find((e) => e.id === employeeId);
    if (me === undefined) throw new Error('unknown employee');
    return me;
  }

  getBalances(employeeId: string): Promise<LeaveBalance[]> {
    return Promise.resolve(
      structuredClone(this.seed.leaveBalances.filter((b) => b.employeeId === employeeId)),
    );
  }

  /** Holidays with from <= date <= to, both ends inclusive, in date order. */
  getHolidays(range: DateRange): Promise<Holiday[]> {
    const inRange = this.seed.holidays.filter((h) => h.date >= range.from && h.date <= range.to);
    return Promise.resolve(structuredClone(inRange).sort((a, b) => a.date.localeCompare(b.date)));
  }

  /** Teammates (requester excluded) on counted leave per date; [] with no team (D-10). */
  async getTeamDayCounts(employeeId: string, range: DateRange): Promise<TeamDayCount[]> {
    const me = this.requester(employeeId);
    const teamId = me.teamId;
    if (teamId === null) return [];
    const mates = new Set(
      this.seed.employees.filter((e) => e.teamId === teamId && e.id !== me.id).map((e) => e.id),
    );
    const leaves = this.seed.leaveRequests.filter(
      (l) =>
        mates.has(l.employeeId) &&
        COUNTED.has(l.status) &&
        l.startDate <= range.to &&
        l.endDate >= range.from,
    );
    return Promise.resolve(countTeamDays(leaves, range));
  }

  /** Team members including the requester (leave-gate D-11); 1 with no team. */
  getTeamSize(employeeId: string): Promise<number> {
    try {
      const me = this.requester(employeeId);
      const teamId = me.teamId;
      if (teamId === null) return Promise.resolve(1);
      return Promise.resolve(this.seed.employees.filter((e) => e.teamId === teamId).length);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error('unknown employee'));
    }
  }
}
