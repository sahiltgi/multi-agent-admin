// Pass rates and threshold enforcement (spec eval-runner, rules 13, 20, 21; D-1, D-3, D-8). Pure.
import {
  EVAL_AGENTS,
  type AgentSummary,
  type AgentThresholds,
  type Bucket,
  type CaseResult,
  type EvalAgent,
  type EvalCategory,
  type Thresholds,
} from './schemas.js';

export type AgentBuckets = Pick<AgentSummary, 'overall' | 'categories' | 'tags' | 'unreviewed'>;

export interface Summary {
  agents: Record<EvalAgent, AgentBuckets>;
  thresholdsMet: boolean;
}

/** A missing flag counts as reviewed: pre-growth lines went through spec review (D-1). */
const isReviewed = (c: CaseResult): boolean => c.reviewed !== false;

function bucket(cases: readonly CaseResult[], threshold: number | null): Bucket {
  const count = (s: CaseResult['status']): number => cases.filter((c) => c.status === s).length;
  const passed = count('passed');
  const failed = count('failed');
  const errored = count('error');
  const unscorable = count('unscorable');
  // Errors and unscorable cases count against the pass rate; skipped cases don't (D-8).
  const denominator = passed + failed + errored + unscorable;
  const passRate = denominator === 0 ? null : passed / denominator;
  return {
    total: cases.length,
    passed,
    failed,
    errored,
    skipped: count('skipped'),
    unscorable,
    passRate,
    threshold,
    // >= meets; a threshold with nothing scored fails closed (rule 21).
    meetsThreshold: threshold === null ? null : passRate !== null && passRate >= threshold,
  };
}

function agentBuckets(cases: readonly CaseResult[], t: AgentThresholds): AgentBuckets {
  const reviewed = cases.filter(isReviewed);
  const categories: AgentBuckets['categories'] = {};
  const named = new Set<EvalCategory>([
    ...reviewed.map((c) => c.category),
    ...(Object.keys(t.categories) as EvalCategory[]),
  ]);
  for (const category of named) {
    categories[category] = bucket(
      reviewed.filter((c) => c.category === category),
      t.categories[category] ?? null,
    );
  }
  const tags: AgentBuckets['tags'] = {};
  for (const [tag, rate] of Object.entries(t.tags ?? {})) {
    tags[tag] = bucket(
      reviewed.filter((c) => c.tags.includes(tag)),
      rate,
    );
  }
  return {
    overall: bucket(reviewed, t.overall ?? null),
    categories,
    tags,
    unreviewed: bucket(
      cases.filter((c) => !isReviewed(c)),
      null,
    ),
  };
}

export function summarize(cases: readonly CaseResult[], thresholds: Thresholds): Summary {
  const agents = Object.fromEntries(
    EVAL_AGENTS.map((agent) => [
      agent,
      agentBuckets(
        cases.filter((c) => c.agent === agent),
        thresholds.agents[agent],
      ),
    ]),
  ) as Record<EvalAgent, AgentBuckets>;
  const buckets = Object.values(agents).flatMap((a) => [
    a.overall,
    ...Object.values(a.categories),
    ...Object.values(a.tags),
  ]);
  return { agents, thresholdsMet: buckets.every((b) => b.meetsThreshold !== false) };
}
