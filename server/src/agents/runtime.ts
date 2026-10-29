// Shared agent runtime: the tool-use loop every agent runs (spec agent-runtime, rules 1–22).
// Enforces the allowlist in code, validates tool I/O with Zod, wraps untrusted content as data
// and writes a redacted audit event for every step. Returns agent output; never a verdict.
import { redact, redactText } from '../lib/redact.js';
import { toAuditEvent, type AuditSink } from './audit.js';
import type { PromptLoader } from './prompts.js';
import type { ToolContext, ToolRegistry } from './registry.js';
import {
  actualModel,
  AgentConfig,
  ModelRequest,
  ModelResponse,
  RunInput,
  RunResult,
  RuntimeAuditPayload,
  ToolUseBlock,
  type AuditKind,
  type ContentBlock,
  type ErrorCode,
  type Message,
  type ModelClient,
  type ToolSpec,
} from './schemas.js';
import { escapeJsonLessThan, wrapUntrusted } from './untrusted.js';

export * from './schemas.js';
export type { AuditSink } from './audit.js';
export type { PromptLoader, PromptLoadResult } from './prompts.js';

export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

/** Returns a cancel function (D-4). */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): () => void;
}

/** Every external dependency is injected (rule 22). */
export interface RuntimeDeps {
  model: ModelClient;
  registry: ToolRegistry;
  prompts: PromptLoader;
  audit: AuditSink;
  clock: Clock;
  scheduler: Scheduler;
  idGen: () => string;
  detectInjection: (text: string) => { flagged: boolean; reason?: string };
}

export interface AgentRuntime {
  run(input: unknown): Promise<RunResult>;
}

/** Thrown inside the loop when a tool_use names a tool outside the allowlist (rule 11). */
export class ToolViolationError extends Error {
  constructor(readonly tool: string) {
    super('Tool call outside the agent allowlist');
    this.name = 'ToolViolationError';
  }
}

/** The sink rejected a write: the run stops with no further calls or writes (D-14). */
class AuditWriteFailed extends Error {}

type Outcome =
  | { outcome: 'completed'; text: string }
  | { outcome: 'max_turns' | 'timeout' | 'refusal' }
  | { outcome: 'tool_violation'; tool: string }
  | { outcome: 'error'; code: ErrorCode };

export type Settled<T> =
  { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'aborted' };

const TOOL_FAILED_TEXT = 'Tool failed. The error was logged.';
const EXCERPT_CHARS = 200;

/** Converts a synchronous throw into a rejection. Also used by the Policy Q&A Agent. */
export function invoke<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(fn());
  });
}

/** Settles with whichever comes first: the promise or the run's abort. Also used by policy_qa. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<Settled<T>> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      promise.catch(() => undefined); // the late result is discarded (rule 7)
      resolve({ kind: 'aborted' });
      return;
    }
    const onAbort = (): void => {
      resolve({ kind: 'aborted' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'value', value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'error', error });
      },
    );
  });
}

/** Zod issue paths and codes only, never received values (rule 12, D-13). */
function issueSummary(issues: readonly { path: PropertyKey[]; code: string }[]): string {
  return issues
    .map((i) => `${i.path.length === 0 ? '(root)' : i.path.map(String).join('.')}: ${i.code}`)
    .join('; ');
}

/** JSON text for a tool result, or undefined when the value has no JSON form. */
function toJson(value: unknown): string | undefined {
  try {
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Every string in a value (object keys included), in document order, for injection scanning. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => stringLeaves(item));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...stringLeaves(child)]);
  }
  return [];
}

/** Model-supplied names are redacted and truncated before they reach the audit or result. */
const safeToolName = (name: string): string => redactText(name).slice(0, 64);

/**
 * D-17: what a model_call event keeps of the messages it sent. User text blocks keep their text
 * (the wrapped input, redacted by audit()); tool results keep only their id, error flag and length.
 */
function auditSentMessage(message: Message): unknown {
  return {
    role: message.role,
    content: message.content.map((block) =>
      block.type === 'tool_result'
        ? {
            type: block.type,
            tool_use_id: block.tool_use_id,
            is_error: block.is_error === true,
            length: typeof block.content === 'string' ? block.content.length : 0,
          }
        : block,
    ),
  };
}

/** D-17: model output is audited as block types and sizes only. No text, no thinking. */
function auditModelBlock(block: ContentBlock): unknown {
  if (block.type === 'tool_use') return { type: block.type, id: block.id, name: block.name };
  const body =
    block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined;
  return typeof body === 'string'
    ? { type: block.type, length: body.length }
    : { type: block.type };
}

export function createRuntime(config: unknown, deps: RuntimeDeps): AgentRuntime {
  const cfg = AgentConfig.parse(config);
  for (const name of cfg.allowlist) {
    if (!deps.registry.has(name)) throw new Error(`Allowlisted tool ${name} is not registered`);
  }
  const allowed = new Set(cfg.allowlist);
  if (allowed.size !== cfg.allowlist.length) throw new Error('Allowlist has duplicate tool names');
  const tools = cfg.allowlist.map((name) => deps.registry.specFor(name));

  return {
    async run(raw) {
      const input = RunInput.parse(raw);
      if (input.agentId !== cfg.agentId) {
        throw new Error(`RunInput agentId ${input.agentId} does not match ${cfg.agentId}`);
      }
      return runOnce(cfg, tools, allowed, deps, input);
    },
  };
}

async function runOnce(
  cfg: AgentConfig,
  tools: ToolSpec[],
  allowed: ReadonlySet<string>,
  deps: RuntimeDeps,
  input: RunInput,
): Promise<RunResult> {
  const { clock } = deps;
  // The model actually called is the one sent and recorded (spec gemini-fallback, rule 8; D-5).
  const calledModel = actualModel(deps.model, cfg.model);
  const start = clock.nowMs();
  const deadline = start + cfg.timeoutMs;
  const controller = new AbortController();
  const { signal } = controller;
  const cancelDeadline = deps.scheduler.setTimeout(() => {
    controller.abort();
  }, cfg.timeoutMs);

  let step = 0;
  let turn = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const toolCalls: { tool: string; output: unknown }[] = [];
  const elapsed = (since: number): number => Math.max(0, Math.round(clock.nowMs() - since));

  const expired = (): boolean => {
    if (!signal.aborted && clock.nowMs() >= deadline) controller.abort();
    return signal.aborted;
  };

  const audit = async (e: {
    kind: AuditKind;
    tool?: string | null;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
    tokens?: { input: number; output: number } | null;
    latencyMs?: number;
    stopReason?: string | null;
    outcome?: string | null;
  }): Promise<void> => {
    step += 1;
    try {
      const payload = RuntimeAuditPayload.parse({
        requestId: input.requestId,
        agent: cfg.agentId,
        step,
        turn,
        kind: e.kind,
        tool: e.tool ?? null,
        input: redact(e.input ?? null), // rule 19: only the audit copy is redacted
        output: redact(e.output ?? null),
        isError: e.isError ?? false,
        tokens: e.tokens ?? null,
        latencyMs: e.latencyMs ?? 0,
        model: calledModel,
        promptVersion: cfg.promptVersion,
        stopReason: e.stopReason ?? null,
        outcome: e.outcome ?? null,
      });
      await deps.audit.write(toAuditEvent(payload, { id: deps.idGen(), at: clock.nowIso() }));
    } catch {
      throw new AuditWriteFailed();
    }
  };

  const result = (o: Outcome): RunResult => {
    const base = {
      requestId: input.requestId,
      agentId: cfg.agentId,
      model: calledModel,
      promptVersion: cfg.promptVersion,
      turns: turn,
      usage: { ...usage },
    };
    switch (o.outcome) {
      case 'completed':
        return RunResult.parse({ ...base, ...o, toolCalls });
      case 'tool_violation':
        return RunResult.parse({ ...base, ...o, escalate: true });
      case 'error':
        return RunResult.parse({ ...base, ...o, escalate: true });
      default:
        return RunResult.parse({ ...base, ...o, escalate: true });
    }
  };

  const finish = async (o: Outcome): Promise<RunResult> => {
    cancelDeadline();
    const out = result(o);
    await audit({
      kind: 'run_end',
      isError: o.outcome !== 'completed',
      output: o.outcome === 'error' ? { code: o.code } : null,
      latencyMs: elapsed(start),
      outcome: o.outcome,
    });
    return out;
  };

  try {
    // ---- system prompt (rule 2): fail closed on missing, empty or unreadable ----
    let system: string | undefined;
    try {
      const loaded = await deps.prompts.load(cfg.agentId, cfg.promptVersion);
      if (loaded.found && loaded.text.trim() !== '') system = loaded.text;
    } catch {
      system = undefined;
    }
    if (system === undefined) return await finish({ outcome: 'error', code: 'prompt_missing' });

    // ---- untrusted content: wrapped once, where it enters the run (rule 16) ----
    const firstMessage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: wrapUntrusted({ source: 'user', text: input.userText }) },
        ...input.documents.map((d) => ({
          type: 'text',
          text: wrapUntrusted({ source: 'document', docId: d.docId, text: d.text }),
        })),
      ],
    };
    const messages: Message[] = [firstMessage];
    let audited = 0; // messages already copied into a model_call audit input

    // ---- injection flags are audit-only and never change the run (rule 17) ----
    const parts = [
      { source: 'user' as const, text: input.userText },
      ...input.documents.map((d) => ({
        source: 'document' as const,
        docId: d.docId,
        text: d.text,
      })),
    ];
    for (const part of parts) {
      const hit = deps.detectInjection(part.text);
      if (!hit.flagged) continue;
      await audit({
        kind: 'injection_flagged',
        input: {
          source: part.source,
          ...('docId' in part ? { docId: part.docId } : {}),
          // Redact before truncating, so a cut can't leave a partial address unmasked.
          excerpt: redactText(part.text).slice(0, EXCERPT_CHARS),
          ...(hit.reason === undefined ? {} : { reason: hit.reason }),
        },
      });
    }

    // ---- the loop (rules 4–9) ----
    while (turn < cfg.maxTurns) {
      if (expired()) return await finish({ outcome: 'timeout' });
      turn += 1;
      const request = ModelRequest.parse({
        model: calledModel,
        system,
        messages,
        tools,
        tool_choice: { type: 'auto' },
        max_tokens: cfg.maxTokens,
        output_config: { effort: cfg.effort },
      });
      // The audit input is what this call newly sends: the wrapped user input, then tool results.
      const sent = { messages: messages.slice(audited).map(auditSentMessage) };
      const callStart = clock.nowMs();
      const remaining = deadline - callStart;
      const settled = await raceAbort(
        invoke(() => deps.model.create(request, { signal, timeout: remaining })),
        signal,
      );

      if (settled.kind === 'aborted' || expired()) {
        await audit({
          kind: 'model_call',
          input: sent,
          isError: true,
          output: { error: 'timeout' },
          latencyMs: elapsed(callStart),
        });
        return await finish({ outcome: 'timeout' });
      }
      if (settled.kind === 'error') {
        // Never the rejection's message: it may carry upstream details (rule 3, D-17).
        await audit({
          kind: 'model_call',
          input: sent,
          isError: true,
          output: { error: 'model_error' },
          latencyMs: elapsed(callStart),
        });
        return await finish({ outcome: 'error', code: 'model_error' });
      }

      const parsed = ModelResponse.safeParse(settled.value);
      const toolUses = parsed.success
        ? parsed.data.content
            .filter((b) => b.type === 'tool_use')
            .map((b) => ToolUseBlock.safeParse(b))
        : [];
      if (!parsed.success || toolUses.some((r) => !r.success)) {
        await audit({
          kind: 'model_call',
          input: sent,
          isError: true,
          latencyMs: elapsed(callStart),
        });
        return await finish({ outcome: 'error', code: 'unexpected_stop_reason' });
      }
      const response = parsed.data;
      const blocks = toolUses.flatMap((r) => (r.success ? [r.data] : []));
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      await audit({
        kind: 'model_call',
        input: sent,
        output: { content: response.content.map(auditModelBlock) },
        tokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
        latencyMs: elapsed(callStart),
        stopReason: response.stop_reason,
      });

      // Rule 5: append the ORIGINAL content, unchanged; ModelResponse just validated its shape.
      const original = (settled.value as { content: ContentBlock[] }).content;
      messages.push({ role: 'assistant', content: original });
      audited = messages.length;

      // Rule 11 + D-6: check every tool_use block, whatever the stop reason, before any handler
      // runs. A disallowed call ends the run even if nothing from this turn would execute.
      try {
        for (const block of blocks) {
          if (!allowed.has(block.name) || !deps.registry.has(block.name)) {
            throw new ToolViolationError(safeToolName(block.name));
          }
        }
      } catch (err) {
        if (!(err instanceof ToolViolationError)) throw err;
        const denied = blocks.find((b) => safeToolName(b.name) === err.tool);
        await audit({
          kind: 'tool_denied',
          tool: err.tool,
          input: denied?.input ?? null,
          isError: true,
        });
        return await finish({ outcome: 'tool_violation', tool: err.tool });
      }

      switch (response.stop_reason) {
        case 'end_turn':
        case 'stop_sequence': {
          const text = response.content
            .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
            .join('');
          return await finish({ outcome: 'completed', text });
        }
        case 'refusal':
          return await finish({ outcome: 'refusal' });
        case 'max_tokens':
          // Tool inputs may be truncated, so nothing from this turn runs (rule 8).
          return await finish({ outcome: 'error', code: 'max_tokens' });
        case 'pause_turn':
          continue; // the paused content is already appended; the while condition caps turns
        case 'tool_use':
          break;
      }

      if (blocks.length === 0) {
        return await finish({ outcome: 'error', code: 'unexpected_stop_reason' });
      }

      // D-15: no turn is left to return results, so the final turn's tool_use never runs.
      if (turn >= cfg.maxTurns) break;

      const ctx: ToolContext = {
        requestId: input.requestId,
        agentId: cfg.agentId,
        actor: { ...input.actor },
        signal,
      };
      const results: ContentBlock[] = [];
      for (const block of blocks) {
        const tool = deps.registry.get(block.name);
        if (tool === undefined) throw new ToolViolationError(safeToolName(block.name)); // checked above
        const toolStart = clock.nowMs();

        // Rule 12: invalid input is a model error; the handler never runs, the loop continues.
        const parsedInput = tool.parseInput(block.input);
        if (!parsedInput.ok) {
          const summary = issueSummary(parsedInput.issues);
          await audit({
            kind: 'tool_input_invalid',
            tool: tool.name,
            input: block.input,
            output: { issues: summary },
            isError: true,
          });
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Invalid tool input: ${summary}`,
            is_error: true,
          });
          continue;
        }

        if (expired()) return await finish({ outcome: 'timeout' });
        const ran = await raceAbort(
          invoke(() => parsedInput.run(ctx)),
          signal,
        );
        if (ran.kind === 'aborted' || (ran.kind === 'error' && signal.aborted)) {
          await audit({
            kind: 'tool_error',
            tool: tool.name,
            input: block.input,
            output: { error: 'timeout' },
            isError: true,
            latencyMs: elapsed(toolStart),
          });
          return await finish({ outcome: 'timeout' });
        }
        if (ran.kind === 'error') {
          // Rule 14: a fixed generic text for the model; the redacted message goes to the audit.
          const message = ran.error instanceof Error ? ran.error.message : 'non-Error thrown';
          await audit({
            kind: 'tool_error',
            tool: tool.name,
            input: block.input,
            output: { message },
            isError: true,
            latencyMs: elapsed(toolStart),
          });
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: TOOL_FAILED_TEXT,
            is_error: true,
          });
          continue;
        }

        // Rule 13: invalid output is a code bug. Never coerced, never forwarded; the run ends.
        const output = tool.outputSchema.safeParse(ran.value);
        // A tool_result must be a JSON string: output a schema accepts but JSON can't hold (a
        // bigint, or a transform to undefined) is also a code bug, handled like invalid output.
        const serialised = output.success ? toJson(output.data) : undefined;
        if (!output.success || serialised === undefined) {
          await audit({
            kind: 'tool_output_invalid',
            tool: tool.name,
            input: block.input,
            output: output.success
              ? { issues: 'output is not JSON-serialisable' }
              : { issues: issueSummary(output.error.issues) },
            isError: true,
            latencyMs: elapsed(toolStart),
          });
          return await finish({ outcome: 'error', code: 'tool_output_invalid' });
        }
        await audit({
          kind: 'tool_call',
          tool: tool.name,
          input: block.input,
          output: output.data,
          latencyMs: elapsed(toolStart),
        });
        toolCalls.push({ tool: tool.name, output: output.data });
        // D-8: tool output is JSON, so it isn't wrapped; it's escaped so it can't form a tag.
        const content = escapeJsonLessThan(serialised);
        // D-8b: tool results are scanned too, on their real text (not the escaped JSON, where
        // quotes, newlines and '<' are escaped). A flag is audit-only and never changes the run.
        const toolText = stringLeaves(output.data).join('\n');
        const hit = deps.detectInjection(toolText);
        if (hit.flagged) {
          await audit({
            kind: 'injection_flagged',
            input: {
              source: 'tool',
              tool: tool.name,
              excerpt: redactText(toolText).slice(0, EXCERPT_CHARS),
              ...(hit.reason === undefined ? {} : { reason: hit.reason }),
            },
          });
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content });
      }
      // Rule 9: every result for this turn in one user message, in block order.
      messages.push({ role: 'user', content: results });
    }
    return await finish({ outcome: 'max_turns' });
  } catch (err) {
    cancelDeadline();
    if (err instanceof AuditWriteFailed) return result({ outcome: 'error', code: 'audit_failed' });
    throw err;
  }
}
