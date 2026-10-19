// classifyMessage (spec orchestrator, rules 6 to 13, 20, 21; D-2, D-6, D-9, D-11, D-14). Runs the
// shared runtime with route() as the only tool, then builds the RoutingDecision in code. The
// model's free text is never read, and nothing here calls the gate or a sub-agent.
import { AuditEvent } from '../../domain/schemas.js';
import { redactText } from '../../lib/redact.js';
import { createRuntime, type RunResult, type RuntimeDeps } from '../runtime.js';
import { ORCHESTRATOR_CONFIG } from './config.js';
import type { FixedMessageLoader } from './messages.js';
import {
  ClarifyingQuestion,
  OrchestratorFailure,
  OrchestratorInput,
  RouteOutput,
  RoutingDecision,
  type FallbackReason,
  type FixedMessageKey,
  type RouteLabel,
} from './schemas.js';

export type OrchestratorDeps = RuntimeDeps & { messages: FixedMessageLoader };

type Choice =
  { source: 'model'; label: RouteLabel } | { source: 'fallback'; reason: FallbackReason };

/** Rules 6 and 7: the model's choice counts only for a completed run with exactly one route call. */
function choose(result: RunResult): Choice {
  if (result.outcome !== 'completed') {
    // chat-endpoint rule 16: only an API timeout or error is model_unavailable; the rest is unchanged.
    const apiFailure =
      result.outcome === 'timeout' || (result.outcome === 'error' && result.code === 'model_error');
    return { source: 'fallback', reason: apiFailure ? 'model_unavailable' : 'run_not_completed' };
  }
  const calls = result.toolCalls.filter((c) => c.tool === 'route');
  if (calls.length === 0) return { source: 'fallback', reason: 'no_route_call' };
  if (calls.length > 1 || result.toolCalls.length > 1) {
    return { source: 'fallback', reason: 'multiple_route_calls' };
  }
  // D-9: the runtime already parsed this with outputSchema, so a failure here is a bug and throws.
  return { source: 'model', label: RouteOutput.parse(calls[0]?.output).label };
}

/** Byte-identical file text, or null when missing, blank, unreadable or (for the question) invalid. */
async function loadFixed(loader: FixedMessageLoader, key: FixedMessageKey): Promise<string | null> {
  let res;
  try {
    res = await loader.load(key);
  } catch {
    return null; // fail closed (D-6)
  }
  if (!res.found || res.text.trim() === '') return null;
  if (key === 'fallback_question' && !ClarifyingQuestion.safeParse(res.text).success) return null;
  return res.text;
}

const MESSAGE_KEY: Partial<Record<RouteLabel, FixedMessageKey>> = {
  prohibited: 'prohibited',
  out_of_scope: 'out_of_scope',
  unclear: 'fallback_question',
};

export async function classifyMessage(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<RoutingDecision | OrchestratorFailure> {
  const parsed = OrchestratorInput.parse(input); // D-14: throws before any model call
  const result = await createRuntime(ORCHESTRATOR_CONFIG, deps).run(parsed);
  const auditFailed = OrchestratorFailure.parse({
    requestId: parsed.requestId,
    outcome: 'error',
    code: 'audit_failed',
    escalate: true,
  });
  // D-6 and agent-runtime D-14: after a sink failure nothing more is written.
  if (result.outcome === 'error' && result.code === 'audit_failed') return auditFailed;
  const choice = choose(result);

  const label: RouteLabel = choice.source === 'model' ? choice.label : 'unclear';
  const base = {
    requestId: parsed.requestId,
    model: ORCHESTRATOR_CONFIG.model,
    promptVersion: ORCHESTRATOR_CONFIG.promptVersion,
    source: choice.source,
    fallbackReason: choice.source === 'fallback' ? choice.reason : null,
  };

  /** False when the sink rejects; the caller then returns auditFailed, never an unaudited result. */
  const writeAudit = async (payload: Record<string, unknown>): Promise<boolean> => {
    const event = AuditEvent.parse({
      id: deps.idGen(),
      traceId: parsed.requestId,
      at: deps.clock.nowIso(),
      actor: { kind: 'agent', id: ORCHESTRATOR_CONFIG.agentId },
      eventType: 'agent_step',
      payload: { ...payload, runOutcome: result.outcome }, // D-11
    });
    try {
      await deps.audit.write(event);
      return true;
    } catch {
      return false;
    }
  };

  const key = MESSAGE_KEY[label];
  const message = key === undefined ? null : await loadFixed(deps.messages, key);
  if (key !== undefined && message === null) {
    const failure = OrchestratorFailure.parse({
      requestId: parsed.requestId,
      outcome: 'error',
      code: 'fixed_message_missing',
      key,
      escalate: true,
    });
    const written = await writeAudit({
      kind: 'routing_failed',
      requestId: parsed.requestId,
      code: 'fixed_message_missing',
      key,
      model: base.model,
      promptVersion: base.promptVersion,
    });
    return written ? failure : auditFailed;
  }

  let decision: RoutingDecision;
  switch (label) {
    case 'leave':
    case 'policy_qa':
    case 'onboarding':
      // Rule 8: fixed table, label → AgentId of the same name.
      decision = RoutingDecision.parse({ ...base, label, targetAgent: label });
      break;
    case 'prohibited':
    case 'out_of_scope':
      decision = RoutingDecision.parse({ ...base, label, reply: message });
      break;
    case 'unclear':
      decision = RoutingDecision.parse({ ...base, label, clarifyingQuestion: message });
      break;
  }

  const written = await writeAudit({
    kind: 'routing_decision',
    requestId: decision.requestId,
    label: decision.label,
    source: decision.source,
    fallbackReason: decision.fallbackReason,
    model: decision.model,
    promptVersion: decision.promptVersion,
    message: message === null ? null : redactText(message), // rule 20: audit copy only
  });
  return written ? decision : auditFailed;
}
