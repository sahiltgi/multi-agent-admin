// Tokens and cost (spec agent-metrics, rule 1; eval-runner rules 24, 25, D-20, D-21). Pure, and it
// imports only zod, so the eval runner and the server share one pricing rule. It sums the token
// counts the agents record on their own model-call audit events (the runtime's `model_call`, the
// Q&A agent's `qa_model_call`) and prices each event at the model that made it. An unpriced model
// throws; it is never priced at 0 or guessed (HARD RULE 6). Cache read/write tokens aren't priced
// (eval-runner OQ-26).
import { z } from 'zod';

// evals/pricing.yaml (eval-runner rule 25; D-20). Prices are config, not secrets.
export const ModelPrice = z
  .object({
    inputPerMTok: z.number().min(0), // USD per million input tokens
    outputPerMTok: z.number().min(0), // USD per million output tokens
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPrice>;

export const Pricing = z
  .object({
    version: z.literal(1),
    asOf: z.iso.date(), // the date the prices were checked
    currency: z.literal('USD'),
    models: z.record(z.string().min(1), ModelPrice), // keyed by model id
  })
  .strict();
export type Pricing = z.infer<typeof Pricing>;

export const TokenCount = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  })
  .strict();
export type TokenCount = z.infer<typeof TokenCount>;

/** A request's totals on its summary audit event (spec agent-metrics, rule 5). */
export const Usage = z.object({ tokens: TokenCount, costUsd: z.number().nonnegative() }).strict();
export type Usage = z.infer<typeof Usage>;

const ModelCallEvent = z.looseObject({
  eventType: z.literal('agent_step'),
  payload: z.looseObject({
    kind: z.enum(['model_call', 'qa_model_call']),
    model: z.string(),
    tokens: z
      .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
      .nullable()
      .optional(),
  }),
});

export function priceEvents(
  events: readonly unknown[],
  pricing: Pricing,
): { tokens: TokenCount; costUsd: number } {
  const tokens = { input: 0, output: 0 };
  let costUsd = 0;
  for (const e of events) {
    const parsed = ModelCallEvent.safeParse(e);
    if (!parsed.success) continue;
    const { model, tokens: t } = parsed.data.payload;
    if (t === null || t === undefined) continue;
    const price = Object.hasOwn(pricing.models, model) ? pricing.models[model] : undefined;
    if (price === undefined) throw new Error('a model call has no pricing entry');
    tokens.input += t.input;
    tokens.output += t.output;
    costUsd += (t.input * price.inputPerMTok + t.output * price.outputPerMTok) / 1e6;
  }
  return { tokens, costUsd };
}
