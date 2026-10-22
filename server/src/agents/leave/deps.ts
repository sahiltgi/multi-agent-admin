// Production Leave Agent wiring, shared by the server and the eval runner (spec eval-runner,
// rule 5): the real gate, the caller's clock date, and the five tools on the runtime registry.
import { evaluateLeave } from '../../gate/leave.js';
import { toIsoDate } from '../../lib/dates.js';
import type { LeaveAgentDeps } from './run.js';
import { buildLeaveTools } from './tools.js';

export type LeaveAgentParts = Omit<LeaveAgentDeps, 'evaluateLeave' | 'toIsoDate'>;

/** Binds the real gate and registers the leave tools on `parts.runtime.registry`. */
export function buildLeaveAgentDeps(parts: LeaveAgentParts): LeaveAgentDeps {
  const deps: LeaveAgentDeps = { ...parts, evaluateLeave, toIsoDate };
  for (const tool of buildLeaveTools(deps)) parts.runtime.registry.register(tool);
  return deps;
}
