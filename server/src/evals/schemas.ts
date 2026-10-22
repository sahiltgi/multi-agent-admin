// Eval runner schemas (spec eval-runner, "Inputs and outputs"; D-1, D-3). Runner-only: what it
// reads (the four agent case files, thresholds.yaml) and what it writes (evals/results/*.json).
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
export const AgentThresholds = z
  .object({
    overall: Rate.optional(),
    categories: z.partialRecord(EvalCategory, Rate),
    tags: z.record(TagName, Rate).optional(), // e.g. prohibited (D-3)
  })
  .strict();
export type AgentThresholds = z.infer<typeof AgentThresholds>;

export const Thresholds = z
  .object({
    version: z.literal(1),
    agents: z
      .object({
        orchestrator: AgentThresholds,
        leave: AgentThresholds,
        policy_qa: AgentThresholds,
        onboarding: AgentThresholds,
      })
      .strict(),
  })
  .strict();
export type Thresholds = z.infer<typeof Thresholds>;

// ---- what the runner writes: evals/results/<YYYY-MM-DD>.json ----
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
  })
  .strict();
export type AgentSummary = z.infer<typeof AgentSummary>;

export const EvalRun = z
  .object({
    schemaVersion: z.literal(1),
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime,
    gitCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    thresholdsHash: z.string().regex(/^[0-9a-f]{64}$/), // SHA-256 of thresholds.yaml bytes
    thresholdsMet: z.boolean(),
    agents: z.array(AgentSummary).length(4),
    cases: z.array(CaseResult),
  })
  .strict();
export type EvalRun = z.infer<typeof EvalRun>;
