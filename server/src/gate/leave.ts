// Leave Policy Gate (spec leave-gate). Pure: no clock, no I/O, no randomness, no model.
// `today` is the only notion of "now", and every verdict comes from the code below (HARD RULE 1).
import { z } from 'zod';
import { countWorkingDays, isInLeavePeriod, isRealCalendarDate } from '../domain/calendar.js';
import {
  LeaveGateResult as DomainLeaveGateResult,
  Id,
  IsoDate,
  LeaveBalance,
  LeaveType,
  LeaveVerdict,
} from '../domain/schemas.js';
import { LoadedLeavePolicy, type RequiredField } from './leave-policy.schema.js';

// ---- Schemas (spec "Inputs and outputs", D-2, D-3) ----

/** A draft request: field-level problems are rule failures, not parse failures (D-2). */
export const LeaveGateRequest = z
  .object({
    employeeId: Id,
    leaveType: z.string().optional(), // checked against LeaveType by required_fields (D-15)
    startDate: z.string().optional(), // calendar validity is checked by dates_valid
    endDate: z.string().optional(),
    startHalf: z.literal('pm').optional(), // leave starts at noon on startDate (D-8)
    endHalf: z.literal('am').optional(), // leave ends at noon on endDate (D-8)
    reason: z.string().optional(), // employee free text: data, never instructions, never echoed
  })
  .strict();
export type LeaveGateRequest = z.infer<typeof LeaveGateRequest>;

export const TeamDayCount = z
  .object({ date: IsoDate, othersOnLeave: z.number().int().nonnegative() })
  .strict();
export type TeamDayCount = z.infer<typeof TeamDayCount>;

export const LeaveGateContext = z
  .object({
    employeeId: Id,
    balances: z.array(LeaveBalance),
    holidays: z.array(IsoDate),
    teamSize: z.number().int().positive(), // includes the requester (D-11)
    teamCalendar: z.array(TeamDayCount),
  })
  .strict()
  .refine((c) => c.balances.every((b) => b.employeeId === c.employeeId), {
    path: ['balances'],
    error: 'every balance must belong to the context employee',
  })
  .refine(
    (c) => new Set(c.balances.map((b) => `${b.leaveType}/${b.period}`)).size === c.balances.length,
    { path: ['balances'], error: 'at most one balance per leave type and period' },
  )
  .refine((c) => new Set(c.teamCalendar.map((d) => d.date)).size === c.teamCalendar.length, {
    path: ['teamCalendar'],
    error: 'at most one entry per date',
  });
export type LeaveGateContext = z.infer<typeof LeaveGateContext>;

/** Fixed order of `ruleResults`; `input_valid` only ever appears alone (D-2, D-5). */
export const LeaveRuleId = z.enum([
  'required_fields',
  'dates_valid',
  'balance_sufficient',
  'notice_period',
  'no_blackout',
  'team_overlap',
  'consecutive_days',
  'special_type',
  'input_valid',
]);
export type LeaveRuleId = z.infer<typeof LeaveRuleId>;

export const LeaveRuleResult = z
  .object({
    ruleId: LeaveRuleId,
    passed: z.boolean(),
    expected: z.string().min(1),
    actual: z.string().min(1),
    message: z.string().min(1), // plain English from templates only (rule 17)
  })
  .strict();
export type LeaveRuleResult = z.infer<typeof LeaveRuleResult>;

export const LeaveGateResult = z
  .object({
    verdict: LeaveVerdict,
    ruleResults: z.array(LeaveRuleResult),
    reason: z.string().min(1), // gate summary, never the employee's request.reason
    policyVersion: z.string().min(1),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LeaveGateResult = z.infer<typeof LeaveGateResult>;

/** Thrown only for invalid `rules`, which come from the boot-time loader, not user data (D-2). */
export class LeaveGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveGateInputError';
  }
}

// ---- Verdict tiers and precedence (rules 11, D-4) ----

const TIER: Record<LeaveRuleId, LeaveVerdict> = {
  required_fields: 'RETURN_TO_EMPLOYEE',
  dates_valid: 'RETURN_TO_EMPLOYEE',
  consecutive_days: 'ESCALATE_TO_HR',
  special_type: 'ESCALATE_TO_HR',
  input_valid: 'ESCALATE_TO_HR',
  balance_sufficient: 'ROUTE_TO_MANAGER_WITH_FLAGS',
  notice_period: 'ROUTE_TO_MANAGER_WITH_FLAGS',
  no_blackout: 'ROUTE_TO_MANAGER_WITH_FLAGS',
  team_overlap: 'ROUTE_TO_MANAGER_WITH_FLAGS',
};

const PRECEDENCE: readonly LeaveVerdict[] = [
  'RETURN_TO_EMPLOYEE',
  'ESCALATE_TO_HR',
  'ROUTE_TO_MANAGER_WITH_FLAGS',
];

const VERDICT_SENTENCE: Record<LeaveVerdict, string> = {
  RETURN_TO_EMPLOYEE: 'Returned to the employee to fix the request.',
  ESCALATE_TO_HR: 'Escalated to HR.',
  ROUTE_TO_MANAGER_WITH_FLAGS: 'Routed to the manager with flags.',
  ROUTE_TO_MANAGER: 'All checks passed; routed to the manager for a decision.',
};

// ---- Day arithmetic on day numbers (rule 9, D-1) ----
// A day number counts days since 1970-01-01, so ranges are counted without stepping
// through every day. Dates reaching these helpers have already passed isRealCalendarDate.

const MS_PER_DAY = 86_400_000;

function toDayNumber(date: string): number {
  const d = new Date(0);
  // setUTCFullYear, unlike Date.UTC, keeps years 0–99 as written.
  d.setUTCFullYear(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return Math.round(d.getTime() / MS_PER_DAY);
}

function fromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Monday to Friday. Day 0 (1970-01-01) was a Thursday. */
function isWeekdayNumber(day: number): boolean {
  const dow = (((day + 4) % 7) + 7) % 7; // 0 = Sunday
  return dow >= 1 && dow <= 5;
}

class WorkingCalendar {
  private readonly holidays: ReadonlySet<number>;

  /** Holiday dates as given; counting goes through countWorkingDays (rule 9; approval-queue-ui L-1). */
  constructor(readonly holidayDates: readonly string[]) {
    // Weekend holidays are dropped here, so they are never treated as extra non-working days.
    this.holidays = new Set(holidayDates.map(toDayNumber).filter(isWeekdayNumber));
  }

  isWorkingDay(day: number): boolean {
    return isWeekdayNumber(day) && !this.holidays.has(day);
  }

  /** Working days in the half-open range [from, to). */
  countFromUntil(from: number, to: number): number {
    if (to <= from) return 0;
    return countWorkingDays(
      { startDate: fromDayNumber(from), endDate: fromDayNumber(to - 1) },
      this.holidayDates,
    );
  }

  /** First working day in [from, to], or undefined. Steps over at most the holidays and a weekend. */
  firstWorkingDay(from: number, to: number): number | undefined {
    for (let d = from; d <= to; d++) if (this.isWorkingDay(d)) return d;
    return undefined;
  }
}

interface Span {
  start: number;
  end: number; // inclusive
  startHalf: boolean;
  endHalf: boolean;
}

// ---- Plain-English formatting (rule 12) ----

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function workingDays(n: number): string {
  return `${formatNumber(n)} working ${n === 1 ? 'day' : 'days'}`;
}

function workingDaysNotice(n: number): string {
  return `${formatNumber(n)} working ${n === 1 ? "day's" : "days'"} notice`;
}

function percent(numerator: number, denominator: number): string {
  return `${formatNumber(Math.round((numerator * 1000) / denominator) / 10)}%`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

const FIELD_LABEL: Record<RequiredField | 'leaveType', string> = {
  leaveType: 'leave type',
  startDate: 'start date',
  endDate: 'end date',
  reason: 'reason',
};

// ---- Rules ----

type Policy = LoadedLeavePolicy['policy'];

interface Evaluated {
  result: LeaveRuleResult;
  checked: boolean; // false for "Not checked" entries, which stay out of the gate reason
}

function pass(ruleId: LeaveRuleId, expected: string, actual: string, message: string): Evaluated {
  return { result: { ruleId, passed: true, expected, actual, message }, checked: true };
}

function fail(ruleId: LeaveRuleId, expected: string, actual: string, message: string): Evaluated {
  return { result: { ruleId, passed: false, expected, actual, message }, checked: true };
}

function notChecked(ruleId: LeaveRuleId, expected: string, cause: string): Evaluated {
  return {
    result: {
      ruleId,
      passed: false,
      expected,
      actual: 'not checked',
      message: `Not checked because ${cause}.`,
    },
    checked: false,
  };
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

interface RequiredCheck {
  evaluated: Evaluated;
  leaveType: LeaveType | undefined;
  cause: string | undefined; // why dependent rules can't run
}

/** Rule 1. Dates are always required: no other rule can run without them. */
function checkRequiredFields(req: LeaveGateRequest, policy: Policy): RequiredCheck {
  const parsedType = LeaveType.safeParse(req.leaveType);
  const leaveType = parsedType.success ? parsedType.data : undefined;
  const typeMissing = isBlank(req.leaveType);
  const typeUnknown = !typeMissing && leaveType === undefined;

  const needed: RequiredField[] = ['startDate', 'endDate'];
  for (const f of leaveType === undefined ? [] : policy.requiredFields[leaveType]) {
    if (!needed.includes(f)) needed.push(f);
  }
  const missing: (RequiredField | 'leaveType')[] = [
    ...(typeMissing ? (['leaveType'] as const) : []),
    ...needed.filter((f) => isBlank(req[f])),
  ];
  const missingLabels = missing.map((f) => FIELD_LABEL[f]);

  const expected =
    leaveType === undefined
      ? 'a recognised leave type, a start date and an end date'
      : `a leave type with ${joinList(needed.map((f) => FIELD_LABEL[f]))}`;

  if (missing.length === 0 && !typeUnknown) {
    return {
      evaluated: pass(
        'required_fields',
        expected,
        'all required fields present',
        'All required fields are present.',
      ),
      leaveType,
      cause: undefined,
    };
  }

  const actualParts: string[] = [];
  const messageParts: string[] = [];
  if (missing.length > 0) {
    actualParts.push(`missing ${joinList(missingLabels)}`);
    messageParts.push(`The request is missing the ${joinList(missingLabels)}.`);
  }
  if (typeUnknown) {
    actualParts.push('leave type not recognised');
    messageParts.push('The leave type is not recognised.'); // the value itself is never echoed
  }
  const firstMissing = missing.find((f) => f !== 'leaveType');
  const cause =
    firstMissing === 'startDate' || firstMissing === 'endDate'
      ? `the ${FIELD_LABEL[firstMissing]} is missing`
      : typeMissing
        ? 'the leave type is missing'
        : typeUnknown
          ? 'the leave type is not recognised'
          : 'a required field is missing';
  return {
    evaluated: fail('required_fields', expected, actualParts.join('; '), messageParts.join(' ')),
    leaveType,
    cause,
  };
}

const DATES_EXPECTED =
  'real start and end dates in YYYY-MM-DD form, the end not before the start, covering at least one working day';

interface DatesCheck {
  evaluated: Evaluated;
  span: Span | undefined;
  amount: number;
}

/** Rule 2, with D-8 (half days) and D-9 (zero working days). */
function checkDates(req: LeaveGateRequest, cal: WorkingCalendar): DatesCheck {
  const unusable = (evaluated: Evaluated): DatesCheck => ({
    evaluated,
    span: undefined,
    amount: 0,
  });
  const invalid = (actual: string, message: string): DatesCheck =>
    unusable(fail('dates_valid', DATES_EXPECTED, actual, message));
  const { startDate, endDate } = req;
  if (startDate === undefined || isBlank(startDate)) {
    return unusable(notChecked('dates_valid', DATES_EXPECTED, 'the start date is missing'));
  }
  if (endDate === undefined || isBlank(endDate)) {
    return unusable(notChecked('dates_valid', DATES_EXPECTED, 'the end date is missing'));
  }
  const startOk = isRealCalendarDate(startDate);
  const endOk = isRealCalendarDate(endDate);
  if (!startOk || !endOk) {
    const which =
      !startOk && !endOk ? 'start and end dates are' : !startOk ? 'start date is' : 'end date is';
    return invalid(
      `the ${which} not a real date in YYYY-MM-DD form`,
      `The ${which} not a valid date; use YYYY-MM-DD.`,
    );
  }
  if (endDate < startDate) {
    return invalid(
      `end date ${endDate} is before start date ${startDate}`,
      `The end date ${endDate} is before the start date ${startDate}.`,
    );
  }
  const startHalf = req.startHalf !== undefined;
  const endHalf = req.endHalf !== undefined;
  if (startDate === endDate && startHalf && endHalf) {
    return invalid(
      'both half-day markers on a single day',
      'A single-day request can mark only one half day.',
    );
  }
  const span: Span = {
    start: toDayNumber(startDate),
    end: toDayNumber(endDate),
    startHalf,
    endHalf,
  };
  // The one count behind balance, consecutive days and dates_valid (rules 9, 10).
  const amount = countWorkingDays(
    {
      startDate,
      endDate,
      ...(req.startHalf === undefined ? {} : { startHalf: req.startHalf }),
      ...(req.endHalf === undefined ? {} : { endHalf: req.endHalf }),
    },
    cal.holidayDates,
  );
  if (amount <= 0) {
    return invalid(
      `${startDate} to ${endDate} covers 0 working days`,
      `The request from ${startDate} to ${endDate} covers no working days.`,
    );
  }
  return {
    evaluated: pass(
      'dates_valid',
      DATES_EXPECTED,
      `${startDate} to ${endDate}, ${workingDays(amount)}`,
      `The dates are valid and cover ${workingDays(amount)}.`,
    ),
    span,
    amount,
  };
}

/** Leave period id `YYYY-YY` containing the date (1 April to 31 March). */
function leavePeriodOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const startYear = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(startYear).padStart(4, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Rule 3, D-13. */
function checkBalance(
  leaveType: LeaveType,
  startDate: string,
  endDate: string,
  amount: number,
  balances: readonly LeaveBalance[],
): Evaluated {
  const expected = `${workingDays(amount)} of ${leaveType} balance needed`;
  const period = leavePeriodOf(startDate);
  if (leavePeriodOf(endDate) !== period) {
    return fail(
      'balance_sufficient',
      expected,
      'the request spans two leave years',
      'The request crosses the 1 April leave-year boundary; check the balances for both years manually.',
    );
  }
  const balance = balances.find(
    (b) => b.leaveType === leaveType && isInLeavePeriod(startDate, b.period),
  );
  if (balance === undefined) {
    return fail(
      'balance_sufficient',
      expected,
      `no ${leaveType} balance for the ${period} leave year`,
      `No ${leaveType} balance was found for the ${period} leave year.`,
    );
  }
  const remaining = balance.entitledDays - balance.usedDays;
  const remainingText = `${formatNumber(remaining)} ${remaining === 1 ? 'day' : 'days'} remaining`;
  if (amount <= remaining) {
    return pass(
      'balance_sufficient',
      expected,
      remainingText,
      `The ${leaveType} balance covers the request (${remainingText}).`,
    );
  }
  return fail(
    'balance_sufficient',
    expected,
    remainingText,
    `The request needs ${workingDays(amount)} but only ${remainingText} of ${leaveType} leave.`,
  );
}

/** Rule 4, D-7 and D-10: working days in [today, startDate). */
function checkNotice(
  leaveType: LeaveType,
  span: Span,
  today: number,
  policy: Policy,
  cal: WorkingCalendar,
): Evaluated {
  const minimum = policy.minNoticeWorkingDays[leaveType];
  const expected = `at least ${workingDaysNotice(minimum)}`;
  const given = cal.countFromUntil(today, span.start);
  const actual = workingDaysNotice(given);
  if (given >= minimum) {
    return pass('notice_period', expected, actual, `The notice period is met (${actual}).`);
  }
  return fail(
    'notice_period',
    expected,
    actual,
    `${leaveType} leave needs at least ${workingDaysNotice(minimum)}, but only ${actual} was given.`,
  );
}

/** Rule 5, D-14: calendar-day overlap, window ends inclusive, every leave type. */
function checkBlackout(startDate: string, endDate: string, policy: Policy): Evaluated {
  const expected = 'no day inside a blackout window';
  const hits = policy.blackoutWindows.filter((w) => w.start <= endDate && w.end >= startDate);
  if (hits.length === 0) {
    return pass('no_blackout', expected, 'no overlap', 'No day falls inside a blackout window.');
  }
  const cited = hits.map((w) => `${w.id} (${w.label}, ${w.start} to ${w.end})`);
  return fail(
    'no_blackout',
    expected,
    `overlaps ${joinList(hits.map((w) => w.id))}`,
    `The request overlaps blackout window ${joinList(cited)}.`,
  );
}

/** Rule 6, D-11: (othersOnLeave + 1) / teamSize, at most the limit, working days only. */
function checkTeamOverlap(
  span: Span,
  ctx: LeaveGateContext,
  policy: Policy,
  cal: WorkingCalendar,
): Evaluated {
  const limit = policy.maxTeamOverlapPercent;
  const expected = `at most ${String(limit)}% of the team on leave on each working day`;
  const exceeds = (others: number): boolean => (others + 1) * 100 > limit * ctx.teamSize;
  const inRequest = ctx.teamCalendar
    .map((e) => ({ day: toDayNumber(e.date), others: e.othersOnLeave }))
    .filter((e) => e.day >= span.start && e.day <= span.end && cal.isWorkingDay(e.day));

  let firstFail: { day: number; others: number } | undefined;
  if (exceeds(0)) {
    const day = cal.firstWorkingDay(span.start, span.end);
    if (day !== undefined)
      firstFail = { day, others: inRequest.find((e) => e.day === day)?.others ?? 0 };
  } else {
    for (const e of inRequest) {
      if (exceeds(e.others) && (firstFail === undefined || e.day < firstFail.day)) firstFail = e;
    }
  }
  if (firstFail !== undefined) {
    const date = fromDayNumber(firstFail.day);
    const share = percent(firstFail.others + 1, ctx.teamSize);
    return fail(
      'team_overlap',
      expected,
      `${share} of the team on leave on ${date}`,
      `On ${date}, ${share} of the team would be on leave, above the ${String(limit)}% limit.`,
    );
  }
  const peak = Math.max(0, ...inRequest.map((e) => e.others));
  return pass(
    'team_overlap',
    expected,
    `at most ${percent(peak + 1, ctx.teamSize)} of the team on leave on any working day`,
    `Team absence stays within the ${String(limit)}% limit on every working day.`,
  );
}

/** Rule 7, D-8 and D-12: more than N escalates, exactly N passes. */
function checkConsecutive(amount: number, policy: Policy): Evaluated {
  const n = policy.escalateAboveConsecutiveWorkingDays;
  const expected = `no more than ${workingDays(n)}`;
  const actual = workingDays(amount);
  if (amount <= n) {
    return pass(
      'consecutive_days',
      expected,
      actual,
      `The request is ${actual}, within the limit.`,
    );
  }
  return fail(
    'consecutive_days',
    expected,
    actual,
    `The request is ${actual}, more than the ${workingDays(n)} a manager can decide; HR reviews it.`,
  );
}

/** Rule 8. */
function checkSpecialType(leaveType: LeaveType, policy: Policy): Evaluated {
  const expected = 'a leave type the manager can decide';
  const actual = `${leaveType} leave`;
  if (!policy.alwaysEscalate.includes(leaveType)) {
    return pass('special_type', expected, actual, `${actual} is decided by the manager.`);
  }
  return fail('special_type', expected, actual, `HR handles ${leaveType} leave requests.`);
}

/** Expected text for rules 3–8 when they can't be computed (D-5). */
function dependentNotChecked(policy: Policy, cause: string): Evaluated[] {
  return [
    notChecked('balance_sufficient', 'enough leave balance for the request', cause),
    notChecked('notice_period', 'the minimum notice for the leave type', cause),
    notChecked('no_blackout', 'no day inside a blackout window', cause),
    notChecked(
      'team_overlap',
      `at most ${String(policy.maxTeamOverlapPercent)}% of the team on leave on each working day`,
      cause,
    ),
    notChecked(
      'consecutive_days',
      `no more than ${workingDays(policy.escalateAboveConsecutiveWorkingDays)}`,
      cause,
    ),
    notChecked('special_type', 'a leave type the manager can decide', cause),
  ];
}

// ---- Verdict, reason and output ----

function pickVerdict(results: readonly LeaveRuleResult[]): LeaveVerdict {
  const failedTiers = new Set(results.filter((r) => !r.passed).map((r) => TIER[r.ruleId]));
  const tier = PRECEDENCE.find((v) => failedTiers.has(v));
  if (tier !== undefined) return tier;
  // ROUTE_TO_MANAGER only when there is at least one result and every one passed.
  return results.length > 0 ? 'ROUTE_TO_MANAGER' : 'ESCALATE_TO_HR';
}

function finish(evaluated: readonly Evaluated[], rules: LoadedLeavePolicy): LeaveGateResult {
  const ruleResults = evaluated.map((e) => e.result);
  const verdict = pickVerdict(ruleResults);
  const failedMessages = evaluated
    .filter((e) => e.checked && !e.result.passed)
    .map((e) => e.result.message);
  return {
    verdict,
    ruleResults,
    reason: [VERDICT_SENTENCE[verdict], ...failedMessages].join(' '),
    policyVersion: rules.policyVersion,
    policyHash: rules.policyHash,
  };
}

function inputInvalid(what: string, rules: LoadedLeavePolicy): LeaveGateResult {
  return finish(
    [
      fail(
        'input_valid',
        'a well-formed request, context and date for the same employee',
        `${what} could not be read`,
        `The request could not be checked automatically because ${what} could not be read; HR must review it.`,
      ),
    ],
    rules,
  );
}

/**
 * Checks a leave request against the loaded leave policy (spec leave-gate). Never approves:
 * the best outcome is ROUTE_TO_MANAGER, and a human decides. Malformed request, context or
 * `today` escalates (D-2); malformed `rules` throws LeaveGateInputError.
 */
export function evaluateLeave(
  request: unknown,
  context: unknown,
  rules: unknown,
  today: unknown,
): LeaveGateResult {
  const parsedRules = LoadedLeavePolicy.safeParse(rules);
  if (!parsedRules.success) {
    throw new LeaveGateInputError('rules must be a LoadedLeavePolicy from the policy loader');
  }
  const loaded = parsedRules.data;
  const policy = loaded.policy;

  const req = LeaveGateRequest.safeParse(request);
  if (!req.success) return inputInvalid('the request', loaded);
  const ctx = LeaveGateContext.safeParse(context);
  if (!ctx.success) return inputInvalid('the context', loaded);
  const day = IsoDate.safeParse(today);
  if (!day.success) return inputInvalid("today's date", loaded);
  if (req.data.employeeId !== ctx.data.employeeId) {
    return inputInvalid('the employee on the request', loaded);
  }

  const cal = new WorkingCalendar(ctx.data.holidays);
  const required = checkRequiredFields(req.data, policy);
  const dates = checkDates(req.data, cal);
  const head = [required.evaluated, dates.evaluated];

  const { leaveType } = required;
  const { span } = dates;
  const { startDate, endDate } = req.data;
  if (
    required.cause !== undefined ||
    leaveType === undefined ||
    span === undefined ||
    startDate === undefined ||
    endDate === undefined
  ) {
    const cause = required.cause ?? 'the dates are not valid';
    return finish([...head, ...dependentNotChecked(policy, cause)], loaded);
  }

  return finish(
    [
      ...head,
      checkBalance(leaveType, startDate, endDate, dates.amount, ctx.data.balances),
      checkNotice(leaveType, span, toDayNumber(day.data), policy, cal),
      checkBlackout(startDate, endDate, policy),
      checkTeamOverlap(span, ctx.data, policy, cal),
      checkConsecutive(dates.amount, policy),
      checkSpecialType(leaveType, policy),
    ],
    loaded,
  );
}

/**
 * The gate result in the domain shape stored on LeaveRequest.gateResult (D-3). Since
 * request-intake D-1 the domain RuleResult equals LeaveRuleResult, so rule results are copied
 * unchanged: nothing is renamed or dropped.
 */
export function toDomainGateResult(result: LeaveGateResult): DomainLeaveGateResult {
  return {
    verdict: result.verdict,
    ruleResults: result.ruleResults.map((r) => ({
      ruleId: r.ruleId,
      passed: r.passed,
      expected: r.expected,
      actual: r.actual,
      message: r.message,
    })),
    reason: result.reason,
    policyVersion: result.policyVersion,
    policyHash: result.policyHash,
  };
}
