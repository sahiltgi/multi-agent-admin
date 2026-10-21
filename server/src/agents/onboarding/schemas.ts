// Onboarding Agent schemas (spec onboarding, rules 10–18). Every tool input and output is strict
// at every depth, and no input carries an identity key (agent-runtime rule 15): the actor comes
// only from ctx.actor, and the new joiner's manager only from the team directory.
import { z } from 'zod';
import {
  ChecklistTask,
  DeviationChange,
  MAX_DEVIATIONS_PER_RUN,
  OnboardingGateResult,
  TemplateId,
  TemplateTaskId,
} from '../../domain/onboarding.js';
import { Id, IsoDate, Role, TaskOwner } from '../../domain/schemas.js';
import { ClarifyingQuestion } from '../orchestrator/schemas.js';
import { RunInput } from '../schemas.js';

// Rule 10: exactly these three. No approve, apply, complete or edit tool exists.
export const ONBOARDING_TOOLS = ['get_template', 'create_checklist', 'propose_deviation'] as const;
export type OnboardingToolName = (typeof ONBOARDING_TOOLS)[number];

const PolicyHash = z.string().regex(/^[a-f0-9]{64}$/);

// ---- get_template (rule 12) ----
export const GetTemplateInput = z.object({ templateId: TemplateId }).strict();
export type GetTemplateInput = z.infer<typeof GetTemplateInput>;

const TemplateTaskView = z
  .object({
    id: TemplateTaskId,
    title: z.string().trim().min(1).max(120),
    owner: TaskOwner,
    dueOffsetDays: z.number().int(),
    dependsOn: z.array(TemplateTaskId),
  })
  .strict();
export const GetTemplateOutput = z
  .object({ templateId: TemplateId, title: z.string(), tasks: z.array(TemplateTaskView) })
  .strict();
export type GetTemplateOutput = z.infer<typeof GetTemplateOutput>;

// ---- create_checklist (rule 13): no tasks, owner, dueDate, done, id or manager key ----
export const CreateChecklistInput = z
  .object({
    templateId: TemplateId,
    startDate: IsoDate,
    newHireTeam: z.string().regex(/^team-[a-z0-9]+$/), // resolved against the directory
    buddyRef: z
      .string()
      .regex(/^emp-\d{3}$/)
      .nullable(), // null when the requester named no buddy
  })
  .strict();
export type CreateChecklistInput = z.infer<typeof CreateChecklistInput>;

export const Assignees = z
  .object({ managerEmployeeId: Id, buddyEmployeeId: Id.nullable() })
  .strict();

export const CreateChecklistOutput = z
  .object({
    templateId: TemplateId,
    startDate: IsoDate,
    newHireTeam: Id,
    assignees: Assignees,
    tasks: z.array(ChecklistTask).min(1), // buildTemplateChecklistTasks output, unchanged
    policyVersion: z.string().min(1),
    policyHash: PolicyHash,
  })
  .strict();
export type CreateChecklistOutput = z.infer<typeof CreateChecklistOutput>;

// ---- propose_deviation (rule 14): the top level is an object; the union is nested ----
const Rationale = z.string().trim().min(1).max(300); // model text: data, never sent to the gate
export const ProposeDeviationInput = z
  .object({ change: DeviationChange, rationale: Rationale })
  .strict();
export type ProposeDeviationInput = z.infer<typeof ProposeDeviationInput>;

/** An echo: "accepted" means recorded as a proposal, never approved. */
export const ProposeDeviationOutput = z
  .object({ accepted: z.literal(true), change: DeviationChange, rationale: Rationale })
  .strict();
export type ProposeDeviationOutput = z.infer<typeof ProposeDeviationOutput>;

// ---- Agent input and result (rules 15, 16) ----
export const OnboardingInput = RunInput.refine((i) => i.agentId === 'onboarding', {
  path: ['agentId'],
  error: 'agentId must be onboarding',
});
export type OnboardingInput = z.infer<typeof OnboardingInput>;

export const ONBOARDING_ESCALATIONS = [
  'run_not_completed', // max_turns, refusal, tool_violation, other errors
  'model_unavailable', // timeout, or error / model_error
  'audit_failed', // agent-runtime D-14
  'multiple_checklists', // more than one successful create_checklist call (rule 13)
  'deviation_without_checklist', // a proposal but no checklist (rule 14)
  'invalid_deviation', // post-run validation failed (rule 14)
  'fallback_text_missing', // a fixed question file is missing or blank (rule 15)
] as const;
export const OnboardingEscalation = z.enum(ONBOARDING_ESCALATIONS);
export type OnboardingEscalation = z.infer<typeof OnboardingEscalation>;

export const ProposedDeviation = z
  .object({ index: z.number().int().nonnegative(), change: DeviationChange, rationale: Rationale })
  .strict();
export type ProposedDeviation = z.infer<typeof ProposedDeviation>;

export const OnboardingAgentResult = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('checklist'),
      requestId: Id,
      checklist: CreateChecklistOutput,
      deviations: z.array(ProposedDeviation).max(MAX_DEVIATIONS_PER_RUN),
      gate: OnboardingGateResult, // exactly what evaluateOnboarding returned
      injectionSuspected: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('needs_details'),
      requestId: Id,
      question: ClarifyingQuestion,
      questionSource: z.enum(['model', 'fallback']),
      injectionSuspected: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('escalated'),
      requestId: Id,
      reason: OnboardingEscalation,
      injectionSuspected: z.boolean(),
    })
    .strict(),
]); // no verdict outside `gate`
export type OnboardingAgentResult = z.infer<typeof OnboardingAgentResult>;

// ---- Audit payloads (rule 18) ----
/** eventType 'gate_result', actor { kind: 'gate', id: 'onboarding' }: the gate output, unredacted. */
export const OnboardingGateResultPayload = OnboardingGateResult.extend({
  kind: z.literal('onboarding_gate_result'),
  requestId: Id,
}).strict();

/** eventType 'agent_step', actor { kind: 'agent', id: 'onboarding' }: the last event. No free text. */
export const OnboardingOutcomePayload = z
  .object({
    kind: z.literal('onboarding_outcome'),
    requestId: Id,
    outcome: z.enum(['checklist', 'needs_details', 'escalated']),
    escalation: OnboardingEscalation.nullable(),
    deviationCount: z.number().int().nonnegative(),
    injectionSuspected: z.boolean(),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
  })
  .strict();

/** eventType 'injection_flagged', actor { kind: 'agent', id: 'onboarding' }: a summary of a flag. */
export const OnboardingInjectionPayload = z
  .object({
    kind: z.literal('injection_flagged'),
    requestId: Id,
    agent: z.literal('onboarding'),
    source: z.enum(['user', 'document', 'tool']),
    tool: z.string().nullable(),
    excerpt: z.string(), // already redacted and bounded by the runtime
    reason: z.string().nullable(),
  })
  .strict();

// ---- Eval cases: evals/onboarding/cases.jsonl ----
export const OnboardingEvalCase = z
  .object({
    id: z.string().regex(/^EV-\d+$/),
    category: z.enum(['routing', 'extraction', 'verdict', 'citation', 'injection']),
    actor: z.object({ employeeId: z.string().regex(/^emp-\d{3}$/), role: Role }).strict(),
    endpoint: z.enum(['messages', 'chat', 'approvals', 'onboarding']),
    userText: z.string().min(1),
    expected: z.record(z.string(), z.unknown()),
    tags: z.array(z.string()),
    notes: z.string().min(1),
  })
  .strict();
export type OnboardingEvalCase = z.infer<typeof OnboardingEvalCase>;
