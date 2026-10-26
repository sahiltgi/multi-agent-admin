// GET /metrics/agents query and response (spec agent-metrics, rules 14, 23). The response carries
// counts, rates and USD only: no employee, request, conversation or checklist id, no free text.
import { z } from 'zod';
import { ROUTE_LABELS } from '../agents/orchestrator/schemas.js';
import { IsoDateTime } from '../domain/schemas.js';
import { TokenCount } from '../lib/cost.js';

export const MetricsQuery = z
  .object({ from: IsoDateTime.optional(), to: IsoDateTime.optional() })
  .strict(); // no role, agent, kind, employeeId or any other key (rule 13)
export type MetricsQuery = z.infer<typeof MetricsQuery>;

export const RouteBucket = z.enum([...ROUTE_LABELS, 'none']);
export type RouteBucket = z.infer<typeof RouteBucket>;

const Count = z.number().int().nonnegative();
const Rate = z.number().min(0).max(1);
const Usd = z.number().nonnegative();

export const AgentMetricsResponse = z
  .object({
    from: IsoDateTime,
    to: IsoDateTime,
    requests: Count,
    byRoute: z
      .object({
        leave: Count,
        policy_qa: Count,
        onboarding: Count,
        prohibited: Count,
        out_of_scope: Count,
        unclear: Count,
        none: Count,
      })
      .strict(),
    verdicts: z
      .object({
        leave: z
          .object({
            ROUTE_TO_MANAGER: Count,
            ROUTE_TO_MANAGER_WITH_FLAGS: Count,
            ESCALATE_TO_HR: Count,
            RETURN_TO_EMPLOYEE: Count,
          })
          .strict(),
        qa: z.object({ AUTO_ANSWER: Count, ESCALATE_TO_HR: Count }).strict(),
        onboarding: z.object({ AUTO: Count, MANAGER: Count }).strict(),
      })
      .strict(), // three distributions, never merged (rule 20)
    escalation: z.object({ count: Count, rate: Rate.nullable() }).strict(),
    cost: z
      .object({
        pricedRequests: Count,
        totalUsd: Usd,
        averageUsd: Usd.nullable(),
        tokens: TokenCount,
      })
      .strict(),
  })
  .strict()
  .refine(
    (r) =>
      Object.values(r.byRoute).reduce((a, b) => a + b, 0) === r.requests &&
      r.escalation.count <= r.requests &&
      r.cost.pricedRequests <= r.requests &&
      (r.escalation.rate === null) === (r.requests === 0) &&
      (r.cost.averageUsd === null) === (r.cost.pricedRequests === 0),
    { error: 'metrics totals are inconsistent' },
  );
export type AgentMetricsResponse = z.infer<typeof AgentMetricsResponse>;
