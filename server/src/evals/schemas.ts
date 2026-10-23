// Eval runner schemas (spec eval-runner, "Inputs and outputs"; D-1, D-3, D-17 to D-21). Runner-only:
// what it reads (the agent case files, thresholds.yaml, pricing.yaml) and what it writes
// (evals/results/<date>-<agent>-<promptVersion>.json).
import { z } from 'zod';
import { LeaveEvalCase } from '../agents/leave/schemas.js';
import { OnboardingEvalCase } from '../agents/onboarding/schemas.js';
import { OrchestratorEvalCase } from '../agents/orchestrator/schemas.js';
import { QaEvalCase } from '../agents/policy_qa/schemas.js';
import { IsoDate, IsoDateTime } from '../domain/schemas.js';

// ---- what the runner reads ----
export const EvalAgent = z.enum(['orchestrator', 'leave', 'policy_qa', 'onboarding']);
export type EvalAgent = z.infer<typeof EvalAgent>;
export const EVAL_AGENTS = EvalAgent.options;

/** CLI arguments (rule 1; D-17): none runs all four agents, one EvalAgent runs that agent only. */
export const EvalArgs = z.union([z.tuple([]), z.tuple([EvalAgent])]);

export const EvalCategory = z.enum(['routing', 'extraction', 'verdict', 'citation', 'injection']);
export type EvalCategory = z.infer<typeof EvalCategory>;

/** Exactly these four files, each parsed with its existing schema (rule 2). */
export const CASE_SOURCES = [
  { agent: 'orchestrator', file: 'orchestrator/cases.jsonl', schema: OrchestratorEvalCase },
  { agent: 'leave', file: 'leave/cases.jsonl', schema: LeaveEvalCase },
  { agent: 'policy_qa', file: 'policy_qa/cases.jsonl', schema: QaEvalCase },
  { agent: 'onboarding', file: 'onboarding/cases.jsonl', schema: OnboardingEvalCase },
] as const;

// evals/thresholds.yaml (rule 4; D-3)
const Rate = z.number().min(0).max(1);
const TagName = z.string().regex(/^[a-z][a-z0-9_]*$/);
const EscalationThresholds = z
  .object({ precision: Rate.optional(), recall: Rate.optional() })
  .strict(); // D-19
export type EscalationThresholds = z.infer<typeof EscalationThresholds>;
export const AgentThresholds = z
  .object({
    overall: Rate.optional(),
    categories: z.partialRecord(EvalCategory, Rate),
    tags: z.record(TagName, Rate).optional(), // e.g. prohibited (D-3)
    escalation: EscalationThresholds.optional(), // D-19: agents with a gate only
  })
  .strict();
export type AgentThresholds = z.infer<typeof AgentThresholds>;
// The orchestrator has no gate, so an escalation block there fails the schema (rule 4; D-19).
const OrchestratorThresholds = AgentThresholds.omit({ escalation: true }).strict();

export const Thresholds = z
  .object({
    version: z.literal(1),
    agents: z
      .object({
        orchestrator: OrchestratorThresholds,
        leave: AgentThresholds,
        policy_qa: AgentThresholds,
        onboarding: AgentThresholds,
      })
      .strict(),
  })
  .strict();
export type Thresholds = z.infer<typeof Thresholds>;

// evals/pricing.yaml (rule 25; D-20). Prices are config, not secrets.
const ModelPrice = z
  .object({
    inputPerMTok: z.number().min(0), // USD per million input tokens
    outputPerMTok: z.number().min(0), // USD per million output tokens
  })
  .strict();
export const Pricing = z
  .object({
    version: z.literal(1),
    asOf: IsoDate, // the date the prices were checked
    currency: z.literal('USD'),
    models: z.record(z.string().min(1), ModelPrice), // keyed by model id
  })
  .strict();
export type Pricing = z.infer<typeof Pricing>;

// ---- what the runner writes: evals/results/<YYYY-MM-DD>-<agent>-<promptVersion>.json (D-18) ----
export const CaseStatus = z.enum(['passed', 'failed', 'error', 'skipped', 'unscorable']);
export type CaseStatus = z.infer<typeof CaseStatus>;
export const SkipReason = z.enum(['blocked', 'instrumented', 'chained']);
export type SkipReason = z.infer<typeof SkipReason>;
export const ErrorCode = z.enum([
  'actor_mismatch', // actor not in the seed, or role differs from the seeded role
  'model_unavailable', // timeout, overloaded, rate limited or network error from the model API
  'run_failed', // any other thrown error inside the agent or app; message not recorded
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// Only enums, ISO dates, ids, counts and booleans. Free text is never stored.
const Token = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]*$/);
export const ObservedValue = z.union([
  Token,
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([Token, z.number()])),
  z.record(Token, z.union([Token, z.number(), z.boolean(), z.null()])),
]);
export type ObservedValue = z.infer<typeof ObservedValue>;

export const Check = z
  .object({
    field: z.string().min(1), // e.g. 'label', 'extracted.startDate', 'invariant.no_agent_approval'
    passed: z.boolean(),
    expected: ObservedValue,
    actual: ObservedValue,
  })
  .strict();
export type Check = z.infer<typeof Check>;

// Rule 24; D-20
export const TokenCount = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  })
  .strict();
export type TokenCount = z.infer<typeof TokenCount>;

export const CaseResult = z
  .object({
    agent: EvalAgent,
    id: Token.min(1), // unique per agent only: (agent, id) is the key
    category: EvalCategory,
    status: CaseStatus,
    reviewed: z.boolean().nullable(), // null when the line has no reviewed flag
    tags: z.array(Token),
    asOf: IsoDate.nullable(),
    skipReason: SkipReason.nullable(), // set iff status === 'skipped'
    skipDetail: Token.nullable(), // e.g. the blocked:* tag
    unscorableKeys: z.array(Token), // non-empty only for 'unscorable'
    errorCode: ErrorCode.nullable(), // set iff status === 'error'
    checks: z.array(Check), // empty unless the case ran
    latencyMs: z.number().int().nonnegative().nullable(),
    tokens: TokenCount, // sum over the case's own audit events; 0/0 when no model call (rule 24)
    costUsd: z.number().nonnegative(), // each model call priced at its own model (D-21)
  })
  .strict()
  .refine((c) => (c.status === 'skipped') === (c.skipReason !== null), {
    path: ['skipReason'],
    error: 'skipReason is set iff the case was skipped',
  })
  .refine((c) => (c.status === 'error') === (c.errorCode !== null), {
    path: ['errorCode'],
    error: 'errorCode is set iff the case errored',
  });
export type CaseResult = z.infer<typeof CaseResult>;

export const Bucket = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unscorable: z.number().int().nonnegative(),
    passRate: Rate.nullable(), // rule 20; null when nothing was scored
    threshold: Rate.nullable(),
    meetsThreshold: z.boolean().nullable(), // null when no threshold applies
  })
  .strict();
export type Bucket = z.infer<typeof Bucket>;

// Rule 23; D-19
export const RateMetric = z
  .object({
    value: Rate.nullable(), // null when the denominator is 0
    threshold: Rate.nullable(),
    meetsThreshold: z.boolean().nullable(), // null when no threshold applies
  })
  .strict();
export type RateMetric = z.infer<typeof RateMetric>;
export const EscalationSummary = z
  .object({
    positive: z.enum(['ESCALATE_TO_HR', 'MANAGER']), // the gate verdict counted as positive
    tp: z.number().int().nonnegative(),
    fp: z.number().int().nonnegative(),
    fn: z.number().int().nonnegative(),
    tn: z.number().int().nonnegative(),
    precision: RateMetric, // TP / (TP + FP)
    recall: RateMetric, // TP / (TP + FN)
  })
  .strict();
export type EscalationSummary = z.infer<typeof EscalationSummary>;

export const AgentSummary = z
  .object({
    agent: EvalAgent,
    model: z.string().min(1), // from the agent's shipped config
    promptVersion: z.string().min(1),
    policyVersion: z.string().nullable(), // null for the orchestrator (no gate)
    policyHash: z.string().nullable(),
    overall: Bucket,
    categories: z.partialRecord(EvalCategory, Bucket),
    tags: z.record(z.string(), Bucket), // only tags that have a threshold (D-3)
    unreviewed: Bucket, // reviewed: false cases only; never thresholded (D-1)
    escalation: EscalationSummary.nullable(), // null for the orchestrator (no gate, D-19)
    tokens: TokenCount, // every case of the agent, reviewed or not (D-20)
    costUsd: z.number().nonnegative(),
  })
  .strict();
export type AgentSummary = z.infer<typeof AgentSummary>;

/** One results file per agent that ran (rule 19; D-18). */
export const EvalRun = z
  .object({
    schemaVersion: z.literal(2),
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime,
    gitCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    thresholdsHash: z.string().regex(/^[0-9a-f]{64}$/), // SHA-256 of thresholds.yaml bytes
    pricingHash: z.string().regex(/^[0-9a-f]{64}$/), // SHA-256 of pricing.yaml bytes (D-20)
    agent: EvalAgent,
    summary: AgentSummary,
    thresholdsMet: z.boolean(), // this agent's buckets and escalation metrics only
    cases: z.array(CaseResult), // this agent's cases only
  })
  .strict()
  .refine((r) => r.summary.agent === r.agent && r.cases.every((c) => c.agent === r.agent), {
    path: ['agent'],
    error: 'a results file holds one agent only',
  });
export type EvalRun = z.infer<typeof EvalRun>;
