// Shipped Claude id → the Gemini model called in its place (spec gemini-fallback, rule 5). Kept apart
// from model-provider.ts so gemini-client.ts can resolve and check models without an import cycle.
// D-4 (owner, 2026-10-28): both map to Flash-Lite, the only free-tier model whose daily quota fits an
// eval run (15 RPM, 250K TPM, 500 RPD; Flash allows only 20 RPD).
export const GEMINI_MODEL_MAP = {
  'claude-sonnet-5-5': 'gemini-3.5-flash-lite',
  'claude-haiku-5-5': 'gemini-3.5-flash-lite',
} as const;

export const GEMINI_MODELS: readonly string[] = [...new Set(Object.values(GEMINI_MODEL_MAP))];

/** Its message names the requested model id only. */
export class UnmappedModelError extends Error {
  override name = 'UnmappedModelError';
  constructor(readonly model: string) {
    super(`no gemini model mapped for ${model}`);
  }
}

/** Never guesses a nearby model (HARD RULE 6); own keys only, so '__proto__' and 'toString' throw. */
export function resolveGeminiModel(requested: string): string {
  if (!Object.hasOwn(GEMINI_MODEL_MAP, requested)) throw new UnmappedModelError(requested);
  return GEMINI_MODEL_MAP[requested as keyof typeof GEMINI_MODEL_MAP];
}
