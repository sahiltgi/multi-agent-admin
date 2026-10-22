// Claude API adapter for the ModelClient port (spec agent-runtime, rule 3; D-2).
// The only file that imports @anthropic-ai/sdk (AT-6). The key is read only through AnthropicEnv
// and never appears in an error message, log line or return value.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ModelClient, ModelRequest } from './schemas.js';

// Not strict: process.env holds many unrelated variables.
export const AnthropicEnv = z.object({ ANTHROPIC_API_KEY: z.string().min(1) });
export type AnthropicEnv = z.infer<typeof AnthropicEnv>;

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// Request timeout, rate limit and every server-side failure, including 529 overloaded.
const isUnavailableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/**
 * True for a transient model API failure: a timeout, an abort, a network error, a rate limit or a
 * server error (spec eval-runner, rule 15). The SDK's connection, timeout and abort errors have no
 * status and a generic name, so they are recognised by class. Reads no message text.
 */
export function isModelUnavailable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIUserAbortError) {
    return true;
  }
  const status =
    typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  if (typeof status === 'number') return isUnavailableStatus(status);
  return err instanceof Error && /^(?:AbortError|TimeoutError)$/.test(err.name);
}

export function createAnthropicClient(env: unknown): ModelClient {
  const parsed = AnthropicEnv.safeParse(env);
  // A fixed message: Zod's own error could echo the received value.
  if (!parsed.success) throw new Error('ANTHROPIC_API_KEY is missing or empty');
  // logLevel 'off' overrides ANTHROPIC_LOG, which at debug level would log request bodies (PII).
  // baseURL is pinned so ANTHROPIC_BASE_URL can't send the key to another host (D-17).
  const client = new Anthropic({
    apiKey: parsed.data.ANTHROPIC_API_KEY,
    logLevel: 'off',
    baseURL: ANTHROPIC_BASE_URL,
  });
  return {
    create: (req: ModelRequest, opts) =>
      client.messages.create(
        // ModelRequest is Zod-validated by the runtime; its content blocks are the SDK's own
        // MessageParam blocks kept opaque (rule 5), so the static types can't line up directly.
        req as unknown as Anthropic.MessageCreateParamsNonStreaming,
        { signal: opts.signal, timeout: opts.timeout },
      ),
  };
}
