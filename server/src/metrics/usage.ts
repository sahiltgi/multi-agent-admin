// A request's token and cost totals for its summary audit event (spec agent-metrics, rules 6–10).
// Read back from the request's own model-call events and priced with the boot-time pricing. A
// failed read or an unpriced model gives null: never a partial sum, never 0 (HARD RULE 6).
import type { AuditEvent } from '../domain/schemas.js';
import type { AuditReader } from '../http/approvals/ports.js';
import { priceEvents, Usage, type Pricing } from '../lib/cost.js';

export async function requestUsage(
  reader: AuditReader,
  pricing: Pricing,
  traceIds: readonly string[],
): Promise<Usage | null> {
  try {
    const events: AuditEvent[] = [];
    for (const id of new Set(traceIds)) events.push(...(await reader.listByTrace(id)));
    return Usage.parse(priceEvents(events, pricing));
  } catch {
    return null;
  }
}
