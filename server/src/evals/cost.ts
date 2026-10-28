// Which models an eval run needs priced (spec eval-runner, rules 24, 25; D-20, D-21). Pricing
// itself is priceEvents in ../lib/cost.ts, shared with the server (spec agent-metrics, rule 1).
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import type { EvalAgent } from './schemas.js';

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
 * onboarding cases go through the app, whose intake calls the orchestrator first (D-21). `resolve`
 * maps a shipped id to the model actually called (spec gemini-fallback, rule 7); it may throw.
 */
export function requiredModels(
  agents: readonly EvalAgent[],
  resolve: (model: string, agent: EvalAgent) => string = (m) => m,
): Map<string, EvalAgent> {
  const out = new Map<string, EvalAgent>();
  const need = (model: string, agent: EvalAgent): void => {
    const id = resolve(model, agent);
    if (!out.has(id)) out.set(id, agent);
  };
  for (const agent of agents) {
    need(agentConfig(agent).model, agent);
    if (agent === 'policy_qa' || agent === 'onboarding') need(ORCHESTRATOR_CONFIG.model, agent);
  }
  return out;
}
