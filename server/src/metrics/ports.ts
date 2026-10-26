// Read port for GET /metrics/agents (spec agent-metrics, rule 15). MongoAuditStore and
// InMemoryAuditReader implement it; the route depends only on this.
import type { AuditEvent } from '../domain/schemas.js';

/** The one summary event each request writes (rules 17, 18). */
export const SUMMARY_KINDS = [
  'intake_outcome',
  'chat_turn',
  'onboarding_created',
  'onboarding_create_escalated',
] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export interface AuditSummaryReader {
  /**
   * Events whose payload.kind is in `kinds` and whose `at` is in [from, to] (canonical UTC
   * strings), sorted by `at` ascending, ties in insertion order. Empty `kinds` gives [].
   */
  listByKinds(kinds: readonly SummaryKind[], from: string, to: string): Promise<AuditEvent[]>;
}
