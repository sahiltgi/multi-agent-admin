// Leave data port (spec leave-agent, rules 3 to 5, 8, 16). Only the interface is in scope; the
// MongoDB implementation comes later. Results are untrusted data, so every handler Zod-parses
// them, and the port is only ever called with ctx.actor.employeeId (rule 2).
import type { DateRange } from './schemas.js';

export interface LeaveDataPort {
  getBalances(employeeId: string): Promise<unknown>;
  getHolidays(range: DateRange): Promise<unknown>;
  /** Other team members on leave per date; excludes the requester (D-10). */
  getTeamDayCounts(employeeId: string, range: DateRange): Promise<unknown>;
  /** Includes the requester. Used by submit_to_gate only; never shown to the model (D-10). */
  getTeamSize(employeeId: string): Promise<unknown>;
}
