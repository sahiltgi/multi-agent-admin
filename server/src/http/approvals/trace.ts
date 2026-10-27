// The trace read shared by GET /audit/:requestId and GET /audit/:requestId/timeline (spec
// approval-queue, rules 13 and 14; spec audit-view, rule 1 and A-9). Both routes call
// readVisibleTrace, so their RBAC, filtering and order can't diverge.
import { AuditEvent } from '../../domain/schemas.js';
import { SUMMARY_KINDS } from '../../metrics/ports.js';
import { HttpError } from '../errors.js';
import type { Actor } from '../identity.js';
import type { ApprovalApiDeps } from './ports.js';
import { canReadTrace } from './rbac.js';

export type TraceReadDeps = Pick<ApprovalApiDeps, 'directory' | 'subjects' | 'auditReader'>;

/** Request-summary payloads whose `usage` only hr_admin sees (spec agent-metrics, rule 11). */
const USAGE_KINDS: ReadonlySet<unknown> = new Set(SUMMARY_KINDS);

/**
 * spec policy-qa DD-24 (rule 23): what a reader who isn't hr_admin gets from a trace. Keyed on
 * event content, so it holds even when no PolicyQuestion was kept. The Q&A gate result (verdict,
 * topic names) and HR's actions on escalation items are dropped, and the per-turn qaVerdict is
 * masked. A summary event's `usage` is dropped (spec agent-metrics, rule 11). Leave gate results
 * and leave decisions are unchanged.
 */
export function askerView(e: AuditEvent): AuditEvent[] {
  const p = e.payload;
  if (p.kind === 'qa_gate_result') return [];
  if (e.eventType === 'human_action' && p.itemKind === 'escalation') return [];
  let payload = p;
  if (USAGE_KINDS.has(p.kind) && 'usage' in payload) {
    payload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'usage'));
  }
  if ((p.kind === 'intake_outcome' || p.kind === 'chat_turn') && 'qaVerdict' in p) {
    payload = { ...payload, qaVerdict: null };
  }
  return [payload === p ? e : { ...e, payload }];
}

/** The events this actor may read for a request, in instant order; 404 for unknown or denied. */
export async function readVisibleTrace(
  deps: TraceReadDeps,
  actor: Actor,
  requestId: string,
): Promise<AuditEvent[]> {
  const ownerId = await deps.subjects.ownerOfRequest(requestId);
  if (ownerId === null) throw new HttpError('not_found');
  const owner = await deps.directory.getById(ownerId);
  // A denied read looks the same as an unknown request (OQ-1).
  const isLeave = await deps.subjects.isLeaveRequest(requestId);
  if (!canReadTrace(actor, owner, isLeave)) throw new HttpError('not_found');
  const events = (await deps.auditReader.listByTrace(requestId))
    .map((e) => AuditEvent.parse(e))
    .flatMap((e) => (actor.role === 'hr_admin' ? [e] : askerView(e)));
  // Array sort is stable, so events at the same instant keep insertion order.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}
