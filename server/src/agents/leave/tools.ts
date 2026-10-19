// The five Leave Agent tools (spec leave-agent, rules 1 to 5, 8, 14, 16; D-19, D-21). Identity
// comes only from ctx.actor, port data is Zod-parsed, and submit_to_gate gathers the gate context
// itself and calls the injected pure gate once. No tool can approve, reject or act for anyone else.
import { z } from 'zod';
import { AuditEvent, Holiday, IsoDate, LeaveBalance } from '../../domain/schemas.js';
import type { LoadedLeavePolicy } from '../../gate/leave-policy.schema.js';
import { LeaveGateResult, type LeaveGateRequest, type TeamDayCount } from '../../gate/leave.js';
import type { ToolContext, ToolDefinition } from '../registry.js';
import type { RuntimeDeps } from '../runtime.js';
import type { LeaveToolDescriptions } from '../tool-descriptions.js';
import { LEAVE_CONFIG } from './config.js';
import type { LeaveDataPort } from './port.js';
import {
  GetHolidaysInput,
  GetHolidaysOutput,
  GetMyBalanceInput,
  GetMyBalanceOutput,
  GetTeamCalendarInput,
  GetTeamCalendarOutput,
  HandBackInput,
  HandBackOutput,
  LeaveAuditPayload,
  SubmitToGateInput,
  SubmitToGateOutput,
  type DateRange,
} from './schemas.js';
import type { FixedTextLoader } from './texts.js';

export interface LeaveAgentDeps {
  runtime: RuntimeDeps;
  data: LeaveDataPort;
  policy: LoadedLeavePolicy; // loaded once at boot, passed to the gate unchanged
  /** The pure gate (`evaluateLeave`), injected so tests can stub it; its return is parsed. */
  evaluateLeave: (request: unknown, context: unknown, rules: unknown, today: unknown) => unknown;
  toIsoDate: (nowIso: string) => string; // UTC calendar date (D-13)
  texts: FixedTextLoader;
  toolDescriptions: LeaveToolDescriptions; // from prompts/leave/tools/ (D-21)
}

// ---- per-run state (rules 9, 13; D-1, D-12) ----
// runLeaveAgent records whether the run wrote injection_flagged (audit-only), and submit_to_gate
// counts every gate evaluation, including one whose gate_result write then failed, so a run can't
// reach the gate twice (rule 9). Keyed by the deps object the tools were built from.
interface RunState {
  injectionSuspected: boolean;
  gateRuns: number;
}
const runStates = new WeakMap<LeaveAgentDeps, Map<string, RunState>>();

export function beginRun(deps: LeaveAgentDeps, requestId: string): void {
  const runs = runStates.get(deps) ?? new Map<string, RunState>();
  runs.set(requestId, { injectionSuspected: false, gateRuns: 0 });
  runStates.set(deps, runs);
}

export function runState(deps: LeaveAgentDeps, requestId: string): RunState | undefined {
  return runStates.get(deps)?.get(requestId);
}

export function endRun(deps: LeaveAgentDeps, requestId: string): void {
  runStates.get(deps)?.delete(requestId);
}

/** A registry-ready tool whose handler input is re-parsed with its own schema (no cast). */
export type LeaveTool = ToolDefinition<z.ZodType, z.ZodType>;

function erase<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): LeaveTool {
  return { ...def, handler: (input, ctx) => def.handler(def.inputSchema.parse(input), ctx) };
}

// ---- port parsing ----
const Balances = z.array(LeaveBalance);
const Holidays = z.array(Holiday);
// Rows may carry more than a date and a count; they are projected, never forwarded (rule 5).
const TeamRows = z.array(
  z.looseObject({ date: IsoDate, othersOnLeave: z.number().int().nonnegative() }),
);
const TeamSize = z.number().int().positive();

const project = (rows: z.infer<typeof TeamRows>): TeamDayCount[] =>
  rows.map((r) => ({ date: r.date, othersOnLeave: r.othersOnLeave }));

/** Rule 3: a balance for anyone else is refused, never returned. */
async function ownBalances(deps: LeaveAgentDeps, employeeId: string): Promise<LeaveBalance[]> {
  const balances = Balances.parse(await deps.data.getBalances(employeeId));
  if (balances.some((b) => b.employeeId !== employeeId)) {
    throw new Error('Data port returned a balance for another employee');
  }
  return balances;
}

/** Rule 8: lookups happen only for real dates in order; otherwise the gate fails them first. */
function requestRange(start: string | undefined, end: string | undefined): DateRange | null {
  if (!IsoDate.safeParse(start).success || !IsoDate.safeParse(end).success) return null;
  if (start === undefined || end === undefined || start > end) return null;
  return { from: start, to: end };
}

async function writeGateResult(
  deps: LeaveAgentDeps,
  ctx: ToolContext,
  gate: LeaveGateResult,
): Promise<void> {
  const { runtime } = deps;
  const payload = LeaveAuditPayload.parse({
    requestId: ctx.requestId,
    agent: 'leave',
    kind: 'gate_result',
    outcome: null,
    gate, // unredacted: template-only text plus the policy hash (D-16)
    summarySource: null,
    injectionSuspected: runState(deps, ctx.requestId)?.injectionSuspected === true,
    model: LEAVE_CONFIG.model,
    promptVersion: LEAVE_CONFIG.promptVersion,
  });
  await runtime.audit.write(
    AuditEvent.parse({
      id: runtime.idGen(),
      traceId: ctx.requestId,
      at: runtime.clock.nowIso(),
      actor: { kind: 'tool', id: 'submit_to_gate' },
      eventType: 'gate_result',
      payload,
    }),
  );
}

export function buildLeaveTools(deps: LeaveAgentDeps): LeaveTool[] {
  const { data, toolDescriptions } = deps;
  return [
    erase({
      name: 'get_my_balance',
      description: toolDescriptions.get_my_balance,
      inputSchema: GetMyBalanceInput,
      outputSchema: GetMyBalanceOutput,
      handler: async (input, ctx) => {
        const balances = await ownBalances(deps, ctx.actor.employeeId);
        return {
          balances:
            input.leaveType === undefined
              ? balances
              : balances.filter((b) => b.leaveType === input.leaveType),
        };
      },
    }),
    erase({
      name: 'get_holidays',
      description: toolDescriptions.get_holidays,
      inputSchema: GetHolidaysInput,
      outputSchema: GetHolidaysOutput,
      handler: async (input) => {
        const holidays = Holidays.parse(await data.getHolidays(input));
        return { holidays: holidays.filter((h) => h.date >= input.from && h.date <= input.to) };
      },
    }),
    erase({
      name: 'get_team_calendar',
      description: toolDescriptions.get_team_calendar,
      inputSchema: GetTeamCalendarInput,
      outputSchema: GetTeamCalendarOutput,
      handler: async (input, ctx) => ({
        days: project(TeamRows.parse(await data.getTeamDayCounts(ctx.actor.employeeId, input))),
      }),
    }),
    erase({
      name: 'submit_to_gate',
      description: toolDescriptions.submit_to_gate,
      inputSchema: SubmitToGateInput,
      outputSchema: SubmitToGateOutput,
      handler: async (input, ctx) => {
        const employeeId = ctx.actor.employeeId;
        const today = IsoDate.parse(deps.toIsoDate(deps.runtime.clock.nowIso()));
        const request: LeaveGateRequest = { employeeId, ...input };
        // The context comes from the port only, never from earlier tool calls (rule 8).
        const balances = await ownBalances(deps, employeeId); // rule 3, as in get_my_balance
        const teamSize = TeamSize.parse(await data.getTeamSize(employeeId));
        const range = requestRange(input.startDate, input.endDate);
        let holidays: string[] = [];
        let teamCalendar: TeamDayCount[] = [];
        if (range !== null) {
          // Notice counts working days from today, so holidays must cover it (leave-gate D-7).
          const from = today < range.from ? today : range.from;
          holidays = Holidays.parse(await data.getHolidays({ from, to: range.to })).map(
            (h) => h.date,
          );
          teamCalendar = project(TeamRows.parse(await data.getTeamDayCounts(employeeId, range)));
        }
        const context = { employeeId, balances, holidays, teamSize, teamCalendar };
        const state = runState(deps, ctx.requestId);
        if (state !== undefined) state.gateRuns += 1; // counted before the gate runs (rule 9)
        const gate = LeaveGateResult.parse(
          deps.evaluateLeave(request, context, deps.policy, today),
        );
        await writeGateResult(deps, ctx, gate);
        return { request, today, gate };
      },
    }),
    // chat-endpoint rule 15: pure. It reads no port, clock or gate; runLeaveAgent sees the call.
    erase({
      name: 'hand_back',
      description: toolDescriptions.hand_back,
      inputSchema: HandBackInput,
      outputSchema: HandBackOutput,
      handler: () => Promise.resolve({ handedBack: true as const }),
    }),
  ];
}
