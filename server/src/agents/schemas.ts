// Agent runtime schemas (spec agent-runtime, "Inputs and outputs" + Decisions).
// Kept apart from runtime.ts so registry.ts can share them without a circular import;
// runtime.ts re-exports everything here.
import { z } from 'zod';
import { Id, Role } from '../domain/schemas.js';

// ---- primitives ----
// 'onboarding_notes': the notes-mode Onboarding Agent behind POST /onboarding (spec onboarding-api, rule 4).
export const AgentId = z.enum([
  'orchestrator',
  'leave',
  'policy_qa',
  'onboarding',
  'onboarding_notes',
]);
export type AgentId = z.infer<typeof AgentId>;

export const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export type ToolName = z.infer<typeof ToolName>;

/** File: prompts/<agentId>/<promptVersion>.md */
export const PromptVersion = z.string().regex(/^v[1-9]\d*$/);
export type PromptVersion = z.infer<typeof PromptVersion>;

/** Matches OutputConfig.effort in @anthropic-ai/sdk 0.133 (D-5). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const Effort = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof Effort>;

// ---- AgentConfig (rule 1; no default model, D-11) ----
export const AgentConfig = z
  .object({
    agentId: AgentId,
    model: z.string().min(1),
    promptVersion: PromptVersion,
    maxTurns: z.number().int().min(1),
    timeoutMs: z.number().int().positive(), // wall-clock budget for the whole run
    maxTokens: z.number().int().positive(), // per model call
    effort: Effort, // sent as output_config.effort
    allowlist: z.array(ToolName).min(1), // every name must exist in the registry
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;

// ---- ModelClient port (only anthropic-client.ts imports the SDK) ----
export const ToolSpec = z
  .object({
    name: ToolName,
    description: z.string().min(1),
    input_schema: z.record(z.string(), z.unknown()), // JSON Schema, additionalProperties: false
    strict: z.literal(true),
  })
  .strict();
export type ToolSpec = z.infer<typeof ToolSpec>;

/** SDK MessageParam shape; content blocks are opaque objects and are never rewritten (rule 5). */
export const ContentBlock = z.looseObject({ type: z.string() });
export type ContentBlock = z.infer<typeof ContentBlock>;
export const Message = z
  .object({ role: z.enum(['user', 'assistant']), content: z.array(ContentBlock) })
  .strict();
export type Message = z.infer<typeof Message>;

export const ModelRequest = z
  .object({
    model: z.string().min(1),
    system: z.string().min(1), // loaded from prompts/ (rule 2)
    messages: z.array(Message),
    tools: z.array(ToolSpec).min(1).optional(), // the agent's allowlist only (rule 4)
    tool_choice: z
      .object({ type: z.literal('auto') })
      .strict()
      .optional(),
    max_tokens: z.number().int().positive(),
    output_config: z.object({ effort: Effort }).strict(),
  })
  .strict()
  // A tool-less agent sends neither key; tool_choice is never sent with an empty tools list
  // (spec policy-qa, DD-19; AT-52).
  .refine((r) => (r.tool_choice !== undefined) === (r.tools !== undefined), {
    path: ['tool_choice'],
    error: 'tool_choice is required exactly when tools is present',
  });
export type ModelRequest = z.infer<typeof ModelRequest>;

/** Read-only view of a response. The runtime appends the ORIGINAL content, never this copy (rule 5). */
export const ModelResponse = z.looseObject({
  content: z.array(ContentBlock),
  stop_reason: z.enum([
    'end_turn',
    'tool_use',
    'max_tokens',
    'pause_turn',
    'refusal',
    'stop_sequence',
  ]),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string(),
  input: z.unknown(),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlock>;

export interface ModelClient {
  create(req: ModelRequest, opts: { signal: AbortSignal; timeout: number }): Promise<unknown>;
}

// ---- RunInput ----
export const Actor = z.object({ employeeId: Id, role: Role }).strict();
export type Actor = z.infer<typeof Actor>;

// D-18: input size limits. Over-limit input fails RunInput, so no model call is made.
export const MAX_USER_TEXT_CHARS = 4000;
export const MAX_DOCUMENTS = 5;
export const MAX_DOCUMENT_CHARS = 20000;

export const UntrustedDoc = z
  .object({ docId: Id, text: z.string().max(MAX_DOCUMENT_CHARS) })
  .strict();
export type UntrustedDoc = z.infer<typeof UntrustedDoc>;

export const RunInput = z
  .object({
    requestId: Id,
    agentId: AgentId,
    actor: Actor,
    userText: z.string().trim().min(1).max(MAX_USER_TEXT_CHARS),
    documents: z.array(UntrustedDoc).max(MAX_DOCUMENTS).default([]),
  })
  .strict();
export type RunInput = z.infer<typeof RunInput>;

// ---- RunResult (no verdict field in any arm, rule 20) ----
const Usage = z
  .object({ input_tokens: z.number().int(), output_tokens: z.number().int() })
  .strict();
const RunBase = {
  requestId: Id,
  agentId: AgentId,
  model: z.string(),
  promptVersion: PromptVersion,
  turns: z.number().int().nonnegative(),
  usage: Usage,
};

export const ERROR_CODES = [
  'max_tokens',
  'tool_output_invalid',
  'prompt_missing',
  'unexpected_stop_reason',
  'model_error',
  'audit_failed',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const RunResult = z.discriminatedUnion('outcome', [
  z
    .object({
      ...RunBase,
      outcome: z.literal('completed'),
      text: z.string(), // callers may use it only as the summary sentence
      toolCalls: z.array(z.object({ tool: ToolName, output: z.unknown() }).strict()),
    })
    .strict(),
  z.object({ ...RunBase, outcome: z.literal('max_turns'), escalate: z.literal(true) }).strict(),
  z.object({ ...RunBase, outcome: z.literal('timeout'), escalate: z.literal(true) }).strict(),
  z
    .object({
      ...RunBase,
      outcome: z.literal('tool_violation'),
      tool: z.string().max(64), // model-supplied name, redacted and truncated
      escalate: z.literal(true),
    })
    .strict(),
  z.object({ ...RunBase, outcome: z.literal('refusal'), escalate: z.literal(true) }).strict(),
  z
    .object({
      ...RunBase,
      outcome: z.literal('error'),
      code: z.enum(ERROR_CODES),
      escalate: z.literal(true),
    })
    .strict(),
]);
export type RunResult = z.infer<typeof RunResult>;

// ---- Audit payload written by the runtime (rule 18; mapped into AuditEvent per D-1) ----
export const AUDIT_KINDS = [
  'model_call',
  'tool_call',
  'tool_denied',
  'tool_input_invalid',
  'tool_output_invalid',
  'tool_error',
  'injection_flagged',
  'run_end',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const RuntimeAuditPayload = z
  .object({
    requestId: Id,
    agent: AgentId,
    step: z.number().int().min(1),
    turn: z.number().int().min(0),
    kind: z.enum(AUDIT_KINDS),
    tool: z.string().max(64).nullable(),
    input: z.unknown(),
    output: z.unknown(),
    isError: z.boolean(),
    tokens: z.object({ input: z.number().int(), output: z.number().int() }).strict().nullable(),
    latencyMs: z.number().int().nonnegative(),
    model: z.string(),
    promptVersion: PromptVersion,
    stopReason: z.string().nullable(),
    outcome: z.string().nullable(),
  })
  .strict();
export type RuntimeAuditPayload = z.infer<typeof RuntimeAuditPayload>;
