// GET /metrics/agents (spec agent-metrics, rules 12–14, 23): hr_admin only, read-only. Aggregates
// the request-summary audit events in a window. The clock is read only for the default window.
import { EmptyBody, EmptyParams } from '../http/approvals/schemas.js';
import { HttpError } from '../http/errors.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { aggregate } from './aggregate.js';
import { SUMMARY_KINDS, type AuditSummaryReader } from './ports.js';
import { AgentMetricsResponse, MetricsQuery } from './schemas.js';

export interface MetricsRouteDeps {
  summaries: AuditSummaryReader;
  clock: { nowIso(): string };
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // rule 14: 30 days

const utc = (iso: string): string => new Date(iso).toISOString();
/** A normalised bound past year 9999 becomes an extended '+010000-…' year that IsoDateTime rejects. */
const fourDigitYear = (iso: string): boolean => /^\d{4}-/.test(iso);

export function createMetricsRoutes(deps: MetricsRouteDeps): RouteDefinition[] {
  const agents = defineRoute({
    method: 'get',
    path: '/metrics/agents',
    params: EmptyParams,
    query: MetricsQuery,
    body: EmptyBody,
    response: AgentMetricsResponse,
    handler: async ({ actor, query }) => {
      // Rule 13: parsing already ran in defineRoute; the role check comes next.
      if (actor.role !== 'hr_admin') throw new HttpError('forbidden');
      const to = utc(query.to ?? deps.clock.nowIso());
      const from =
        query.from === undefined
          ? new Date(Date.parse(to) - DEFAULT_WINDOW_MS).toISOString()
          : utc(query.from);
      if (!fourDigitYear(from) || !fourDigitYear(to) || Date.parse(from) > Date.parse(to)) {
        throw new HttpError('invalid_request', [
          { path: ['query', 'from'], code: 'window_invalid' },
        ]);
      }
      const events = await deps.summaries.listByKinds(SUMMARY_KINDS, from, to);
      try {
        return aggregate(events, { from, to });
      } catch {
        throw new HttpError('internal_error'); // a malformed stored event fails closed (rule 16)
      }
    },
  });
  return [agents];
}
