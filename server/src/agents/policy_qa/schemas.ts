// Policy Q&A Agent schemas (spec policy-qa, "Inputs and outputs", rules 13-18). The gate result
// schema comes from domain/qa.ts, so nothing here reaches server/src/gate/ (AT-31).
import { z } from 'zod';
import { QaGateResult } from '../../domain/qa.js';
import { Id, Role } from '../../domain/schemas.js';
import { MAX_USER_TEXT_CHARS } from '../schemas.js';

export const PolicyQaInput = z
  .object({
    requestId: Id,
    actor: z.object({ employeeId: Id, role: Role }).strict(), // role is never sent to the model
    question: z.string().trim().min(1).max(MAX_USER_TEXT_CHARS),
  })
  .strict();
export type PolicyQaInput = z.infer<typeof PolicyQaInput>;

/** The first user content block: the cached, citation-enabled handbook (rule 14). */
export const HandbookDocumentBlock = z
  .object({
    type: z.literal('document'),
    source: z
      .object({
        type: z.literal('text'),
        media_type: z.literal('text/plain'),
        data: z.string().min(1),
      })
      .strict(),
    title: z.literal('Employee Handbook'),
    citations: z.object({ enabled: z.literal(true) }).strict(),
    cache_control: z.object({ type: z.literal('ephemeral') }).strict(),
  })
  .strict();
export type HandbookDocumentBlock = z.infer<typeof HandbookDocumentBlock>;

// ---- Response parsing at the agent boundary (rule 15; DD-7) ----

/** The only accepted citation: a plain-text location in the one document we send. */
export const CharLocationCitation = z.looseObject({
  type: z.literal('char_location'),
  cited_text: z.string(),
  document_index: z.literal(0),
  start_char_index: z.number().int().nonnegative(),
  end_char_index: z.number().int().nonnegative(),
}); // document_title and later API fields are tolerated, never read

export const QaTextBlock = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
  citations: z.array(z.unknown()).nullable().optional(), // each must parse as CharLocationCitation
});

/** Skipped: thinking can't be turned off on this model, and it is never answer text (DD-19). */
export const IGNORED_BLOCK_TYPES: readonly string[] = ['thinking', 'redacted_thinking'];

export const QaUsage = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
});

export const QaModelResponse = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })).min(1),
  stop_reason: z.string(),
  usage: QaUsage,
});
export type QaModelResponse = z.infer<typeof QaModelResponse>;

export const QaFailureReason = z.enum([
  'model_unavailable', // timeout or model_error (chat-endpoint OD-2)
  'stop_reason', // any stop_reason other than end_turn
  'unsupported_block', // neither text nor an ignored thinking block
  'unsupported_citation', // not char_location with document_index 0
  'empty_answer', // the concatenated text is blank
  'invalid_response', // fails QaModelResponse
  'audit_failed', // an audit write was rejected (agent-runtime D-14)
]);
export type QaFailureReason = z.infer<typeof QaFailureReason>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const QaProvenance = z
  .object({ policyVersion: z.string().min(1), policyHash: Sha256, handbookHash: Sha256 })
  .strict();
export type QaProvenance = z.infer<typeof QaProvenance>;

/** No verdict outside `gate`, and no confidence anywhere (rule 17). */
export const PolicyQaResult = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('gated'),
      requestId: Id,
      gate: QaGateResult, // exactly what the gate returned
      answerText: z.string().min(1), // shown on AUTO_ANSWER; the draft answer on escalation
      provenance: QaProvenance,
      injectionSuspected: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('failed'),
      requestId: Id,
      reason: QaFailureReason,
      answerText: z.string().min(1).nullable(), // the parsed text if any, else null
      provenance: QaProvenance,
      injectionSuspected: z.boolean(),
    })
    .strict(),
]);
export type PolicyQaResult = z.infer<typeof PolicyQaResult>;

// ---- Audit payloads (rule 18) ----

/** eventType 'agent_step', actor { kind: 'agent', id: 'policy_qa' }. */
export const QaModelCallPayload = z
  .object({
    kind: z.literal('qa_model_call'),
    requestId: Id,
    agent: z.literal('policy_qa'),
    model: z.string(),
    promptVersion: z.string(),
    input: z.string(), // redactText(question) only; never the handbook or the system prompt
    output: z.string().nullable(), // redactText(answerText) only on AUTO_ANSWER, else null
    answerChars: z.number().int().nonnegative(),
    citationCount: z.number().int().nonnegative(),
    stopReason: z.string().nullable(),
    tokens: z
      .object({
        input: z.number().int(),
        output: z.number().int(),
        cacheRead: z.number().int().nullable(),
        cacheCreation: z.number().int().nullable(),
      })
      .strict()
      .nullable(),
    latencyMs: z.number().int().nonnegative(),
    isError: z.boolean(),
    failure: QaFailureReason.nullable(),
  })
  .strict();
export type QaModelCallPayload = z.infer<typeof QaModelCallPayload>;

/** eventType 'injection_flagged', actor { kind: 'agent', id: 'policy_qa' }. */
export const QaInjectionPayload = z
  .object({
    kind: z.literal('injection_flagged'),
    requestId: Id,
    agent: z.literal('policy_qa'),
    source: z.literal('user'),
    excerpt: z.string(), // redacted and bounded
    reason: z.string().nullable(),
  })
  .strict();

/** eventType 'gate_result', actor { kind: 'gate', id: 'qa' }: the gate output, unredacted. */
export const QaGateResultPayload = QaGateResult.extend({
  kind: z.literal('qa_gate_result'),
  requestId: Id,
}).strict();

// ---- Eval cases: evals/policy_qa/cases.jsonl ----

export const QaEvalCase = z
  .object({
    id: z.string().regex(/^EV-\d+$/),
    category: z.enum(['routing', 'extraction', 'verdict', 'citation', 'injection']),
    actor: z.object({ employeeId: z.string().regex(/^emp-\d{3}$/), role: Role }).strict(),
    endpoint: z.enum(['messages', 'chat']),
    userText: z.string().min(1),
    instrumented: z.string().min(1).optional(), // the replay edit or fault, for instrumented cases
    expected: z
      .object({
        outcome: z
          .enum(['policy_answer', 'policy_escalated', 'escalated', 'retry', 'reply', 'boot_fails'])
          .optional(),
        verdict: z.enum(['AUTO_ANSWER', 'ESCALATE_TO_HR']).optional(),
        sectionIds: z.array(z.string().regex(/^HB-\d+\.\d+$/)).optional(),
        topics: z
          .array(z.enum(['harassment', 'medical', 'disciplinary', 'compensation', 'legal']))
          .optional(),
        injectionFlagged: z.boolean().optional(),
      })
      .strict(),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_:-]*$/)),
    notes: z.string().min(1),
    reviewed: z.boolean().optional(), // set by a human labeller only (eval growth)
  })
  .strict();
export type QaEvalCase = z.infer<typeof QaEvalCase>;
