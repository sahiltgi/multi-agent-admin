// Tokens and cost (spec eval-runner, rules 24, 25; D-20, D-21). Pure: sums the token counts the
// agents record on their own model-call audit events (the runtime's `model_call`, the Q&A agent's
// `qa_model_call`) and prices each event at the model that made it. An unpriced model throws; it
// is never priced at 0 or guessed (HARD RULE 6). Cache read/write tokens aren't priced (OQ-26).
import { z } from 'zod';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import type { EvalAgent, Pricing, TokenCount } from './schemas.js';

/** The shipped model and prompt version per agent; the runner never overrides them (rule 5). */
export function agentConfig(agent: EvalAgent): { model: string; promptVersion: string } {
  switch (agent) {
    case 'orchestrator':
      return ORCHESTRATOR_CONFIG;
    case 'leave':
      return LEAVE_CONFIG;
    case 'policy_qa':
      return POLICY_QA_CONFIG;
    case 'onboarding':
      return ONBOARDING_CONFIG;
  }
}

/**
 * Every model a run of these agents can call, mapped to an agent that needs it. policy_qa and
 * onboarding cases go through the app, whose intake calls the orchestrator first (D-21).
 */
export function requiredModels(agents: readonly EvalAgent[]): Map<string, EvalAgent> {
  const out = new Map<string, EvalAgent>();
  for (const agent of agents) {
    if (!out.has(agentConfig(agent).model)) out.set(agentConfig(agent).model, agent);
    if ((agent === 'policy_qa' || agent === 'onboarding') && !out.has(ORCHESTRATOR_CONFIG.model)) {
      out.set(ORCHESTRATOR_CONFIG.model, agent);
    }
  }
  return out;
}

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

export function priceCase(
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
