// Leave Agent AgentConfig values (spec leave-agent, rule 1; D-18). Parsed by the runtime with
// AgentConfig; the runtime itself has no default model (agent-runtime D-11).
import type { AgentConfig } from '../schemas.js';
import { LEAVE_TOOLS } from './schemas.js';

export const LEAVE_CONFIG: AgentConfig = {
  agentId: 'leave',
  model: 'claude-sonnet-5-5', // mid-tier for agents (brief §7, D-18)
  promptVersion: 'v1',
  allowlist: [...LEAVE_TOOLS], // exactly the four leave tools; no approve tool exists (rule 1)
  maxTurns: 8, // three lookups, one submission, a retry after an is_error, and the final text
  timeoutMs: 60000,
  maxTokens: 1024,
  effort: 'low',
};
