// Which model API runs the agents (spec gemini-fallback, rules 1, 2, 5, 8). A present Anthropic key
// always wins; Gemini is the fallback when only GEMINI_API_KEY is set (D-1). Pure apart from building
// a client; never logs, and errors name variables only, never values.
import { z } from 'zod';
import { NO_MODEL_KEY_MESSAGE, OptionalKey } from '../domain/schemas.js';
import { createAnthropicClient } from './anthropic-client.js';
import { createGeminiClient } from './gemini-client.js';
import { resolveGeminiModel } from './gemini-models.js';
import type { ModelClient } from './schemas.js';

export { NO_MODEL_KEY_MESSAGE, OptionalKey } from '../domain/schemas.js';
export { GEMINI_MODEL_MAP, UnmappedModelError } from './gemini-models.js';
export { actualModel } from './schemas.js';

// Not strict: process.env holds unrelated variables.
export const ProviderEnv = z.object({
  ANTHROPIC_API_KEY: OptionalKey,
  GEMINI_API_KEY: OptionalKey,
});
export type Provider = 'anthropic' | 'gemini';

/** Throws Error(NO_MODEL_KEY_MESSAGE) when neither key is present. */
export function selectProvider(env: unknown): Provider {
  const parsed = ProviderEnv.safeParse(env);
  if (parsed.success && parsed.data.ANTHROPIC_API_KEY !== undefined) return 'anthropic';
  if (parsed.success && parsed.data.GEMINI_API_KEY !== undefined) return 'gemini';
  throw new Error(NO_MODEL_KEY_MESSAGE);
}

/** Anthropic is the identity; Gemini throws UnmappedModelError rather than guess (HARD RULE 6). */
export function resolveModelId(provider: Provider, requested: string): string {
  return provider === 'anthropic' ? requested : resolveGeminiModel(requested);
}

export function createModelClient(env: unknown): ModelClient {
  return selectProvider(env) === 'anthropic' ? createAnthropicClient(env) : createGeminiClient(env);
}
