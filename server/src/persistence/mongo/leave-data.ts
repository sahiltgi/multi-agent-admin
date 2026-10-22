// LeaveDataPort on MongoDB (spec mongo-persistence, rule 8; D-14; leave-agent D-10;
// leave-gate D-11). Reads only; every count is computed here, never a verdict.
import type { DateRange } from '../../agents/leave/schemas.js';
import type { LeaveDataPort } from '../../agents/leave/port.js';
import { COUNTED_STATUSES, countTeamDays } from '../../agents/leave/team-days.js';
import type { TeamDayCount } from '../../gate/leave.js';
import { Employee, Holiday, LeaveBalance, LeaveRequest } from '../../domain/schemas.js';
import { MODELS } from '../../models/index.js';
import { literal, NO_STORAGE_KEYS, parseAllStored, parseStored } from './read.js';

export class MongoLeaveDataPort implements LeaveDataPort {
  /** The requester, or a rejection for an unknown id. */
  private async requester(employeeId: string): Promise<Employee> {
    const doc = await MODELS.Employee.findOne({ id: literal(employeeId) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    if (doc === null) throw new Error('unknown employee');
    return parseStored(Employee, 'employees', doc);
  }

  async getBalances(employeeId: string): Promise<LeaveBalance[]> {
    const docs = await MODELS.LeaveBalance.find(
      { employeeId: literal(employeeId) },
      NO_STORAGE_KEYS,
    )
      .lean()
      .exec();
    return parseAllStored(LeaveBalance, 'leaveBalances', docs);
  }

  /** Holidays with from <= date <= to, both ends inclusive, in date order. */
  async getHolidays(range: DateRange): Promise<Holiday[]> {
    const docs = await MODELS.Holiday.find(
      { date: { $gte: range.from, $lte: range.to } },
      NO_STORAGE_KEYS,
    )
      .sort({ date: 1 })
      .lean()
      .exec();
    return parseAllStored(Holiday, 'holidays', docs);
  }

  /**
   * Per calendar date, the number of distinct teammates (requester excluded) with a counted
   * request covering it. A half day counts on its date. Dates with zero are omitted, one entry
   * per date, ascending. A requester with no team gets [] (leave-agent D-10).
   */
  async getTeamDayCounts(employeeId: string, range: DateRange): Promise<TeamDayCount[]> {
    const me = await this.requester(employeeId);
    if (me.teamId === null) return [];
    const mates = parseAllStored(
      Employee,
      'employees',
      await MODELS.Employee.find(
        { teamId: literal(me.teamId), id: { $ne: me.id } },
        NO_STORAGE_KEYS,
      )
        .lean()
        .exec(),
    );
    if (mates.length === 0) return [];
    const leaves = parseAllStored(
      LeaveRequest,
      'leaveRequests',
      await MODELS.LeaveRequest.find(
        {
          employeeId: { $in: mates.map((m) => m.id) },
          status: { $in: [...COUNTED_STATUSES] },
          startDate: { $lte: range.to },
          endDate: { $gte: range.from },
        },
        NO_STORAGE_KEYS,
      )
        .lean()
        .exec(),
    );
    return countTeamDays(leaves, range);
  }

  /** Team members including the requester (leave-gate D-11); 1 with no team (D-14). */
  async getTeamSize(employeeId: string): Promise<number> {
    const me = await this.requester(employeeId);
    if (me.teamId === null) return 1;
    return MODELS.Employee.countDocuments({ teamId: literal(me.teamId) }).exec();
  }
}
