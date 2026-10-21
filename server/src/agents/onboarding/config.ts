// Onboarding Agent AgentConfig values (spec onboarding, rule 10; OQ-14: copies the Leave Agent's).
// Parsed by the runtime with AgentConfig; the runtime itself has no default model.
import type { AgentConfig } from '../schemas.js';
import { ONBOARDING_TOOLS } from './schemas.js';

export const ONBOARDING_CONFIG: AgentConfig = {
  agentId: 'onboarding',
  model: 'claude-sonnet-5-5', // mid-tier for agents (brief §7)
  promptVersion: 'v1',
  allowlist: [...ONBOARDING_TOOLS], // exactly the three onboarding tools (rule 10)
  maxTurns: 8,
  timeoutMs: 60000,
  maxTokens: 1024,
  effort: 'low',
};
