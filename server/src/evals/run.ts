// The eval runner (spec eval-runner). Checks the key, reads thresholds and cases, then runs every
// eligible case end to end on a fresh seeded world, scores it in code, summarises, and writes one
// results file. Exit 0 = thresholds met, 1 = missed, 2 = setup error with no results file.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicEnv } from '../agents/anthropic-client.js';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import type { Clock, Scheduler } from '../agents/runtime.js';
import type { ModelClient } from '../agents/schemas.js';
import { loadLeavePolicy } from '../policies/load.js';
import { fixtures } from '../seeds/fixtures.js';
import { loadBootFiles, type BootFiles } from '../server/boot.js';
import { timerScheduler } from '../server/runtime.js';
import { drive } from './drivers.js';
import { readCases, readThresholds, SetupError, type LoadedCase } from './load.js';
import { watchModel, type WatchedModel } from './model.js';
import {
  observeInvariant,
  observeLeave,
  observeOnboarding,
  observeOrchestrator,
  observePolicyQa,
  type RunOutput,
} from './observe.js';
import { writeResults, summaryLines } from './results.js';
import {
  EvalRun,
  type AgentSummary,
  type CaseResult,
  type ErrorCode,
  type EvalAgent,
  type SkipReason,
} from './schemas.js';
import {
  scoreLeave,
  scoreOnboarding,
  scoreOrchestrator,
  scorePolicyQa,
  type Scored,
} from './score/agents.js';
import { token, tokens } from './score/checks.js';
import { invariantCheck } from './score/invariant.js';
import { summarize } from './summary.js';
import { createCaseWorld, type CaseWorld } from './world.js';

export interface EvalDeps {
  env: Readonly<Record<string, string | undefined>>; // ANTHROPIC_API_KEY
  evalsDir: string; // holds <agent>/cases.jsonl, thresholds.yaml and results/
  model: ModelClient;
  realClock: Clock; // run start and results date; each case clock is offset from it (rule 9)
  scheduler?: Scheduler;
  gitCommit?: string | null;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  onCaseEnd?: (c: {
    agent: string;
    id: string;
    auditEvents: readonly unknown[];
    firstId: string | null;
  }) => void;
}

export interface EvalOutcome {
  exitCode: 0 | 1 | 2;
  run: EvalRun | null;
  resultsPath: string | null;
}

// Prompts and policies always come from the repo, never from evalsDir (rule 5).
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Policy = ReturnType<typeof loadLeavePolicy>;

interface Ctx {
  deps: EvalDeps;
  boot: BootFiles;
  policy: Policy;
  scheduler: Scheduler;
}

function skipOf(c: LoadedCase): { reason: SkipReason; detail: string | null } | null {
  const blocked = c.tags.find((t) => t.startsWith('blocked:'));
  if (blocked !== undefined) return { reason: 'blocked', detail: token(blocked) };
  if (c.instrumented) return { reason: 'instrumented', detail: null };
  if (c.tags.includes('chained')) return { reason: 'chained', detail: null };
  return null;
}

/** The case actor must exist in the seed with exactly that role (rule 8). */
function actorMatches(c: LoadedCase): boolean {
  const seeded = fixtures.employees.find((e) => e.id === c.actor.employeeId);
  return seeded?.role === c.actor.role;
}

async function score(
  c: LoadedCase,
  out: RunOutput,
  world: CaseWorld,
  model: WatchedModel,
  boot: BootFiles,
): Promise<Scored> {
  const events = world.sink.events;
  if (c.agent === 'orchestrator' && out.agent === 'orchestrator') {
    return scoreOrchestrator(c.expected, observeOrchestrator(out.decision, events));
  }
  if (c.agent === 'leave' && out.agent === 'leave') {
    return scoreLeave(c.expected, observeLeave(out.result, events));
  }
  if (c.agent === 'policy_qa' && out.agent === 'policy_qa') {
    return scorePolicyQa(c.expected, observePolicyQa(out, events));
  }
  if (c.agent === 'onboarding' && out.agent === 'onboarding') {
    return scoreOnboarding(
      c.expectedKeys,
      c.expected,
      await observeOnboarding(out, world, model, boot),
    );
  }
  throw new Error('driver output does not match the case agent');
}

async function runCase(c: LoadedCase, ctx: Ctx): Promise<CaseResult> {
  const base = {
    agent: c.agent,
    id: c.id,
    category: c.category,
    reviewed: c.reviewed,
    tags: tokens(c.tags), // case text never reaches the results file (rule 19)
    asOf: c.asOf,
    skipReason: null,
    skipDetail: null,
    unscorableKeys: [],
    errorCode: null,
    checks: [],
    latencyMs: null,
  };
  const skip = skipOf(c);
  if (skip !== null) {
    return { ...base, status: 'skipped', skipReason: skip.reason, skipDetail: skip.detail };
  }
  if (!actorMatches(c)) return { ...base, status: 'error', errorCode: 'actor_mismatch' };

  const { deps } = ctx;
  const world = createCaseWorld(deps.realClock, c.asOf);
  const model = watchModel(deps.model);
  const started = deps.realClock.nowMs();
  // A throw makes the case an error; its message is never recorded (rule 15).
  const out: RunOutput | null = await drive(c, {
    boot: ctx.boot,
    policy: ctx.policy,
    world,
    model: model.client,
    scheduler: ctx.scheduler,
  }).catch(() => null);
  const latencyMs = Math.max(0, Math.round(deps.realClock.nowMs() - started));
  deps.onCaseEnd?.({
    agent: c.agent,
    id: c.id,
    auditEvents: world.sink.events,
    firstId: world.firstId(),
  });

  const serverError = out !== null && 'response' in out && out.response.status >= 500;
  const error: ErrorCode | null =
    model.failure() ?? (out === null || serverError ? 'run_failed' : null);
  if (error !== null || out === null) {
    return { ...base, status: 'error', errorCode: error ?? 'run_failed', latencyMs };
  }

  // One case's failure never stops the run (rule 15): a throw while observing is that case's error.
  const graded = await Promise.all([
    score(c, out, world, model, ctx.boot),
    observeInvariant(world),
  ]).catch(() => null);
  if (graded === null) return { ...base, status: 'error', errorCode: 'run_failed', latencyMs };
  const [scored, invariant] = graded;
  const checks = [...scored.checks, invariantCheck(invariant)];
  const status =
    scored.unscorableKeys.length > 0 || scored.checks.length === 0
      ? 'unscorable'
      : checks.every((k) => k.passed)
        ? 'passed'
        : 'failed';
  return { ...base, status, unscorableKeys: scored.unscorableKeys, checks, latencyMs };
}

function agentMeta(
  agent: EvalAgent,
  boot: BootFiles,
  policy: Policy,
): Pick<AgentSummary, 'model' | 'promptVersion' | 'policyVersion' | 'policyHash'> {
  switch (agent) {
    case 'orchestrator':
      return {
        model: ORCHESTRATOR_CONFIG.model,
        promptVersion: ORCHESTRATOR_CONFIG.promptVersion,
        policyVersion: null,
        policyHash: null,
      };
    case 'leave':
      return {
        model: LEAVE_CONFIG.model,
        promptVersion: LEAVE_CONFIG.promptVersion,
        policyVersion: policy.policyVersion,
        policyHash: policy.policyHash,
      };
    case 'policy_qa':
      return {
        model: POLICY_QA_CONFIG.model,
        promptVersion: POLICY_QA_CONFIG.promptVersion,
        policyVersion: boot.qaPolicy.policyVersion,
        policyHash: boot.qaPolicy.policyHash,
      };
    case 'onboarding':
      return {
        model: ONBOARDING_CONFIG.model,
        promptVersion: ONBOARDING_CONFIG.promptVersion,
        policyVersion: boot.onboardingPolicy.policyVersion,
        policyHash: boot.onboardingPolicy.policyHash,
      };
  }
}

export async function runEvals(deps: EvalDeps): Promise<EvalOutcome> {
  const fail = (message: string): EvalOutcome => {
    deps.stderr(`evals: ${message}`);
    return { exitCode: 2, run: null, resultsPath: null };
  };

  // The key comes first and is never printed (rule 3).
  if (!AnthropicEnv.safeParse(deps.env).success) {
    return fail('ANTHROPIC_API_KEY is missing or empty. Set it in .env (see .env.example).');
  }
  let thresholds: ReturnType<typeof readThresholds>;
  let cases: LoadedCase[];
  let boot: BootFiles;
  let policy: Policy;
  try {
    thresholds = readThresholds(deps.evalsDir);
    cases = readCases(deps.evalsDir);
  } catch (err) {
    if (err instanceof SetupError) return fail(err.message);
    throw err;
  }
  try {
    boot = await loadBootFiles(join(REPO_ROOT, 'prompts'));
    policy = loadLeavePolicy(join(REPO_ROOT, 'policies', 'leave', 'v1.yaml'));
  } catch {
    return fail('the prompts, fixed texts or policies could not be loaded.');
  }

  const ctx: Ctx = { deps, boot, policy, scheduler: deps.scheduler ?? timerScheduler };
  const startedAt = deps.realClock.nowIso();
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, ctx)); // one at a time (rule 7)
  const finishedAt = deps.realClock.nowIso();

  const summary = summarize(results, thresholds.thresholds);
  const run = EvalRun.parse({
    schemaVersion: 1,
    startedAt,
    finishedAt,
    gitCommit: deps.gitCommit ?? null,
    thresholdsHash: thresholds.hash,
    thresholdsMet: summary.thresholdsMet,
    agents: (Object.keys(summary.agents) as EvalAgent[]).map((agent) => ({
      agent,
      ...agentMeta(agent, boot, policy),
      ...summary.agents[agent],
    })),
    cases: results,
  });
  const resultsPath = writeResults(deps.evalsDir, startedAt.slice(0, 10), run);
  for (const line of summaryLines(run, resultsPath)) deps.stdout(line);
  return { exitCode: run.thresholdsMet ? 0 : 1, run, resultsPath };
}
