// Gemini adapter for the ModelClient port (spec gemini-fallback, rules 9–24). It calls the
// OpenAI-compatible chat completions endpoint with plain fetch (D-2) and translates both ways, so the
// runtime, gate and audit see the same Anthropic-shaped request and response as before. Every doubt
// fails closed (HARD RULE 6). The key is read only through GeminiEnv, goes only into the
// authorization header and never appears in an error, log line or return value (rule 20).
import { z } from 'zod';
import { GEMINI_MODELS, resolveGeminiModel } from './gemini-models.js';
import { ToolName, type ModelClient, type ModelRequest, type ToolSpec } from './schemas.js';

export const GeminiEnv = z.object({ GEMINI_API_KEY: z.string().min(1) });
export type GeminiEnv = z.infer<typeof GeminiEnv>;

// Pinned, like the Anthropic base URL (D-3): no env variable can send the key to another host.
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const COMPLETIONS_URL = new URL('chat/completions', GEMINI_BASE_URL).href;

/** The free tier's 15 requests per minute (rule 24, D-15). */
export const GEMINI_MIN_START_GAP_MS = 4000;

export interface GeminiDeps {
  fetch: typeof globalThis.fetch;
  nowMs: () => number;
  /** Resolves after ms; rejects as soon as signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** HTTP or transport failure. Fixed message; never the response body, URL or headers (rule 15). */
export class GeminiApiError extends Error {
  override name = 'GeminiApiError';
  constructor(
    readonly status: number | null, // null for network, abort and timeout failures
    readonly unavailable: boolean, // rule 19
  ) {
    super(status === null ? 'gemini request failed' : `gemini request failed ${String(status)}`);
  }
}

export type GeminiProtocolCode =
  | 'model_not_mapped'
  | 'unsupported_block'
  | 'invalid_response'
  | 'invalid_tool_arguments'
  | 'unknown_finish_reason';

/** The request couldn't be translated, or the response failed parsing or translation. */
export class GeminiProtocolError extends Error {
  override name = 'GeminiProtocolError';
  constructor(readonly code: GeminiProtocolCode) {
    super(`gemini protocol error: ${code}`);
  }
}

// Request timeout, rate limit and every server-side failure.
const isUnavailableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const unavailable = (): GeminiApiError => new GeminiApiError(null, true);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- request (rules 11–13) ----

const GeminiToolCallOut = z
  .object({
    id: z.string().min(1),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }).strict(),
    extra_content: z.unknown().optional(), // echoed back only if received (D-13)
  })
  .strict();
type GeminiToolCallOut = z.infer<typeof GeminiToolCallOut>;
const TextPart = z.object({ type: z.literal('text'), text: z.string() }).strict();
type TextPart = z.infer<typeof TextPart>;
const GeminiMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal('user'), content: z.array(TextPart).min(1) }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      tool_calls: z.array(GeminiToolCallOut).min(1).optional(),
    })
    .strict(),
  z
    .object({ role: z.literal('tool'), tool_call_id: z.string().min(1), content: z.string() })
    .strict(),
]);
type GeminiMessage = z.infer<typeof GeminiMessage>;
const GeminiChatRequest = z
  .object({
    model: z.string().refine((m) => GEMINI_MODELS.includes(m)), // rule 9
    messages: z.array(GeminiMessage).min(2),
    tools: z
      .array(
        z
          .object({
            type: z.literal('function'),
            function: z
              .object({
                name: ToolName,
                description: z.string().min(1),
                parameters: z.record(z.string(), z.unknown()),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    tool_choice: z.literal('auto').optional(), // present exactly when tools is
    max_tokens: z.number().int().positive(),
    reasoning_effort: z.enum(['low', 'medium', 'high']), // D-6
  })
  .strict(); // no temperature, output_config, cache_control or stream
type GeminiChatRequest = z.infer<typeof GeminiChatRequest>;

// Incoming Anthropic-shaped blocks, read field by field; anything else is unsupported (rule 11).
const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const TextDocumentBlock = z.looseObject({
  type: z.literal('document'),
  source: z.looseObject({ type: z.literal('text'), data: z.string() }),
});
const ToolUseBlockIn = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string(),
  input: z.unknown(),
  gemini_extra_content: z.unknown().optional(),
});
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(TextBlock)]),
});
const DROPPED_ASSISTANT_BLOCKS = new Set(['thinking', 'redacted_thinking']);

function parseBlock<T>(schema: z.ZodType<T>, block: unknown): T {
  const parsed = schema.safeParse(block);
  if (!parsed.success) throw new GeminiProtocolError('unsupported_block');
  return parsed.data;
}

function userMessages(content: readonly { type: string }[]): GeminiMessage[] {
  const tools: GeminiMessage[] = [];
  const parts: TextPart[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'tool_result': {
        // is_error isn't sent: the runtime's fixed texts already say what failed (D-9).
        const r = parseBlock(ToolResultBlock, block);
        const text =
          typeof r.content === 'string' ? r.content : r.content.map((t) => t.text).join('');
        tools.push({ role: 'tool', tool_call_id: r.tool_use_id, content: text });
        break;
      }
      case 'text':
        parts.push({ type: 'text', text: parseBlock(TextBlock, block).text });
        break;
      case 'document':
        // Title, citations and cache_control are dropped (D-8).
        parts.push({ type: 'text', text: parseBlock(TextDocumentBlock, block).source.data });
        break;
      default:
        throw new GeminiProtocolError('unsupported_block');
    }
  }
  return parts.length > 0 ? [...tools, { role: 'user', content: parts }] : tools;
}

function assistantMessage(content: readonly { type: string }[]): GeminiMessage {
  const texts: string[] = [];
  const calls: GeminiToolCallOut[] = [];
  for (const block of content) {
    if (DROPPED_ASSISTANT_BLOCKS.has(block.type)) continue;
    if (block.type === 'text') {
      texts.push(parseBlock(TextBlock, block).text);
    } else if (block.type === 'tool_use') {
      const t = parseBlock(ToolUseBlockIn, block);
      calls.push({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input) },
        ...(t.gemini_extra_content === undefined ? {} : { extra_content: t.gemini_extra_content }),
      });
    } else {
      throw new GeminiProtocolError('unsupported_block');
    }
  }
  return {
    role: 'assistant',
    content: texts.length > 0 ? texts.join('') : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

/** Deep copy without `additionalProperties` or `$schema` at any depth (D-7). */
function stripSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchema);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== 'additionalProperties' && k !== '$schema')
      .map(([k, v]) => [k, stripSchema(v)]),
  );
}

const toolOf = (t: ToolSpec) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: stripSchema(t.input_schema) as Record<string, unknown>,
  },
});

/** Pure; builds a new body and never changes req (agent-runtime rule 5). */
export function toGeminiRequest(req: ModelRequest): GeminiChatRequest {
  if (!GEMINI_MODELS.includes(req.model)) throw new GeminiProtocolError('model_not_mapped');
  const messages: GeminiMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push(...userMessages(m.content));
    else messages.push(assistantMessage(m.content));
  }
  const effort = req.output_config.effort;
  const parsed = GeminiChatRequest.safeParse({
    model: req.model,
    messages,
    ...(req.tools === undefined ? {} : { tools: req.tools.map(toolOf), tool_choice: 'auto' }),
    max_tokens: req.max_tokens,
    reasoning_effort: effort === 'xhigh' || effort === 'max' ? 'high' : effort,
  });
  if (!parsed.success) throw new GeminiProtocolError('unsupported_block');
  return parsed.data;
}

// ---- response (rules 16–18) ----

const GeminiToolCallIn = z.looseObject({
  id: z.string().min(1), // missing or empty fails closed (D-10)
  type: z.literal('function'),
  function: z.looseObject({ name: z.string().min(1), arguments: z.string() }),
  extra_content: z.unknown().optional(),
});
const GeminiResponse = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullable(),
        message: z.looseObject({
          role: z.literal('assistant'),
          content: z.string().nullable().optional(),
          tool_calls: z.array(GeminiToolCallIn).optional(),
        }),
      }),
    )
    .length(1),
  usage: z.looseObject({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

/** D-11: tool calls win over `stop`; anything unknown rejects. */
function stopReasonOf(finish: string | null, hasCalls: boolean): StopReason {
  switch (finish) {
    case 'stop':
      return hasCalls ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      if (!hasCalls) throw new GeminiProtocolError('invalid_response');
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      throw new GeminiProtocolError('unknown_finish_reason');
  }
}

/** A plain JSON object, never repaired (D-10). '' gives {}. */
function toolInput(args: string): Record<string, unknown> {
  if (args === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new GeminiProtocolError('invalid_tool_arguments');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeminiProtocolError('invalid_tool_arguments');
  }
  return value as Record<string, unknown>;
}

/** Pure; returns an object that parses as ModelResponse. */
export function fromGeminiResponse(body: unknown): {
  content: Record<string, unknown>[];
  stop_reason: StopReason;
  usage: { input_tokens: number; output_tokens: number };
} {
  const parsed = GeminiResponse.safeParse(body);
  if (!parsed.success) throw new GeminiProtocolError('invalid_response');
  const { choices, usage } = parsed.data;
  const [choice] = choices;
  if (choice === undefined) throw new GeminiProtocolError('invalid_response');
  const calls = choice.message.tool_calls ?? [];
  const stop_reason = stopReasonOf(choice.finish_reason, calls.length > 0);
  const text = choice.message.content;
  const content: Record<string, unknown>[] = [
    ...(typeof text === 'string' && text !== '' ? [{ type: 'text', text }] : []),
    ...calls.map((c) => ({
      type: 'tool_use',
      id: c.id,
      name: c.function.name,
      input: toolInput(c.function.arguments),
      ...(c.extra_content === undefined ? {} : { gemini_extra_content: c.extra_content }),
    })),
  ];
  return {
    content,
    stop_reason,
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
}

// ---- client ----

export function createGeminiClient(env: unknown, deps: Partial<GeminiDeps> = {}): ModelClient {
  const parsed = GeminiEnv.safeParse(env);
  // A fixed message: Zod's own error could echo the received value.
  if (!parsed.success) throw new Error('GEMINI_API_KEY is missing or empty');
  const key = parsed.data.GEMINI_API_KEY;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let lastStart: number | null = null;

  return {
    async create(req, opts) {
      // Everything up to the slot runs before the first await, so concurrent calls get slots in
      // call order; a request rejected here takes no slot (rule 24).
      const body = toGeminiRequest(req);
      if (opts.signal.aborted) throw unavailable();
      const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeout)]);
      const now = nowMs();
      const start = lastStart === null ? now : Math.max(now, lastStart + GEMINI_MIN_START_GAP_MS);
      lastStart = start; // never released, so the pace is never faster than 15 RPM

      const wait = start - now;
      if (wait > 0) {
        try {
          // The wait is fixed at reservation; yield once so every concurrent caller reserves its
          // slot before any wait starts.
          await Promise.resolve();
          await sleep(wait, signal);
        } catch {
          throw unavailable();
        }
      }
      if (signal.aborted) throw unavailable();

      let res: Response;
      try {
        res = await doFetch(COMPLETIONS_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
          // A redirect would re-send the prompt body to another host; it fails as unavailable (D-3).
          redirect: 'error',
        });
      } catch {
        throw unavailable(); // the cause isn't kept: it can echo the request
      }
      if (!res.ok) {
        // Drained only; the body can echo the request and never reaches the error (rule 15).
        await res.body?.cancel().catch(() => undefined);
        throw new GeminiApiError(res.status, isUnavailableStatus(res.status));
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw unavailable();
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new GeminiProtocolError('invalid_response');
      }
      return fromGeminiResponse(json);
    },
    resolveModel: resolveGeminiModel, // rule 8
  };
}
