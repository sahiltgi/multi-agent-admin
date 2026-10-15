// Audit sink port and the RuntimeAuditPayload → domain AuditEvent mapping (spec agent-runtime,
// rule 18; D-1, D-3). Only an in-memory sink is in scope; the MongoDB sink comes later.
import { AuditEvent } from '../domain/schemas.js';
import type { AuditKind, RuntimeAuditPayload } from './schemas.js';

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

/** For tests and local runs. Keeps events in write order. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

const EVENT_TYPES: Record<AuditKind, AuditEvent['eventType']> = {
  model_call: 'agent_step',
  run_end: 'agent_step',
  tool_call: 'tool_call',
  tool_input_invalid: 'tool_call',
  tool_output_invalid: 'tool_call',
  tool_error: 'tool_call',
  tool_denied: 'tool_call_denied',
  injection_flagged: 'injection_flagged',
};

/**
 * D-1: the agent is the actor for model_call, run_end, injection_flagged and tool_denied (a denied
 * name is untrusted and may be empty, so it stays in payload.tool only); the tool is the actor
 * for the other tool_* kinds. Parsed, so a malformed event never reaches the sink.
 */
export function toAuditEvent(
  payload: RuntimeAuditPayload,
  ids: { id: string; at: string },
): AuditEvent {
  const toolActor =
    payload.kind !== 'tool_denied' && payload.kind.startsWith('tool_') && payload.tool !== null;
  return AuditEvent.parse({
    id: ids.id,
    traceId: payload.requestId,
    at: ids.at,
    actor:
      toolActor && payload.tool !== null
        ? { kind: 'tool', id: payload.tool }
        : { kind: 'agent', id: payload.agent },
    eventType: EVENT_TYPES[payload.kind],
    payload,
  });
}
