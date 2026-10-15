// Orchestrator AgentConfig values (spec orchestrator, rule 2; D-1, D-9). Parsed by the runtime
// with AgentConfig; the runtime itself has no default model (agent-runtime D-11).
import type { AgentConfig } from '../schemas.js';

export const ORCHESTRATOR_CONFIG: AgentConfig = {
  agentId: 'orchestrator',
  model: 'claude-haiku-5-5', // the small routing model (D-1)
  promptVersion: 'v1',
  allowlist: ['route'], // route() is the only tool (rule 3)
  maxTurns: 3, // route, then end_turn, with one turn spare for a retried invalid call (D-9)
  timeoutMs: 30000,
  maxTokens: 1024,
  effort: 'low',
};
