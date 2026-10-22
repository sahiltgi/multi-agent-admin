// Pure wiring of the running server (spec mongo-persistence, rule 10 step 7; D-18). Reads no env
// and opens no connection: everything arrives in ServerParts, so tests use in-memory ports.
import type { Express } from 'express';
import { buildLeaveAgentDeps } from '../agents/leave/deps.js';
import { runLeaveAgent } from '../agents/leave/run.js';
import { runOnboardingNotesAgent } from '../agents/onboarding/notes.js';
import { runOnboardingAgent, type OnboardingAgentDeps } from '../agents/onboarding/run.js';
import { buildOnboardingTools } from '../agents/onboarding/tools.js';
import { classifyMessage } from '../agents/orchestrator/classify.js';
import { runPolicyQa } from '../agents/policy_qa/run.js';
import { createProductionRegistry } from '../agents/registry.js';
import type { Clock, RuntimeDeps, Scheduler } from '../agents/runtime.js';
import type { ModelClient } from '../agents/schemas.js';
import { detectInjectionHeuristic } from '../agents/untrusted.js';
import { createChatRoutes } from '../chat/routes.js';
import type { LoadedLeavePolicy } from '../gate/leave-policy.schema.js';
import { evaluateOnboarding } from '../gate/onboarding.js';
import { createApp } from '../http/app.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import type { IntakeDeps } from '../intake/ports.js';
import { createIntakeRoutes } from '../intake/routes.js';
import { toIsoDate } from '../lib/dates.js';
import { createOnboardingRoutes, type OnboardingRouteDeps } from '../onboarding/routes.js';
import type { ServerStores } from '../persistence/mongo/connect.js';
import type { BootFiles } from './boot.js';

export type { ServerStores } from '../persistence/mongo/connect.js';

export interface ServerParts {
  policy: LoadedLeavePolicy;
  boot: BootFiles;
  stores: ServerStores;
  model: ModelClient;
  clock: Clock;
  scheduler: Scheduler;
  idGen: () => string;
  /** Tests only: replaces the classifyMessage and runLeaveAgent bindings. */
  agents?: Pick<IntakeDeps, 'classify' | 'runLeave'> &
    Partial<Pick<IntakeDeps, 'runPolicyQa' | 'runOnboarding'>> &
    Partial<Pick<OnboardingRouteDeps, 'runOnboardingNotes'>>;
}

export function buildApp(parts: ServerParts): Express {
  const { boot, stores, clock, idGen } = parts;

  // One registry; each agent's allowlist limits what it may call (agent-runtime rule 11).
  const registry = createProductionRegistry(boot.descriptions);
  const runtime: RuntimeDeps = {
    model: parts.model,
    registry,
    prompts: boot.prompts,
    audit: stores.audit,
    clock,
    scheduler: parts.scheduler,
    idGen,
    detectInjection: detectInjectionHeuristic,
  };
  const leaveDeps = buildLeaveAgentDeps({
    runtime,
    data: stores.leaveData,
    policy: parts.policy,
    texts: boot.leaveTexts,
    toolDescriptions: boot.leaveToolDescriptions,
  });
  // spec onboarding, rules 10, 27: the three onboarding tools, the boot policy and the real gate.
  const onboardingDeps: OnboardingAgentDeps = {
    runtime,
    directory: stores.directory,
    policy: boot.onboardingPolicy,
    evaluateOnboarding,
    toIsoDate,
    texts: boot.onboardingAgentTexts,
    toolDescriptions: boot.onboardingToolDescriptions,
  };
  for (const tool of buildOnboardingTools(onboardingDeps)) registry.register(tool);

  const approvalDeps: ApprovalApiDeps = {
    directory: stores.directory,
    approvals: stores.approvals,
    subjects: stores.leaveRequests, // one store: intake's requests reach the queue (D-2)
    audit: stores.audit,
    auditReader: stores.audit,
    clock,
    idGen,
    onboarding: stores.onboarding,
  };
  const intakeDeps: IntakeDeps = {
    directory: stores.directory,
    leaveRequests: stores.leaveRequests,
    approvals: stores.approvals,
    approvalReader: stores.approvals,
    audit: stores.audit,
    clock,
    idGen,
    classify:
      parts.agents?.classify ??
      ((input) => classifyMessage(input, { ...runtime, messages: boot.orchestratorMessages })),
    runLeave: parts.agents?.runLeave ?? ((input) => runLeaveAgent(input, leaveDeps)),
    texts: boot.intakeTexts,
    idempotency: stores.idempotency,
    // spec policy-qa, rules 19, 26: one call with the boot-time handbook, policy and prompt.
    runPolicyQa:
      parts.agents?.runPolicyQa ??
      ((input) =>
        runPolicyQa(input, {
          model: parts.model,
          prompts: boot.prompts,
          audit: stores.audit,
          clock,
          scheduler: parts.scheduler,
          idGen,
          detectInjection: detectInjectionHeuristic,
          handbookBody: boot.handbook.body,
          handbookHash: boot.handbook.hash,
          policy: boot.qaPolicy,
        })),
    policyQuestions: stores.policyQuestions,
    qaTexts: boot.qaTexts,
    runOnboarding:
      parts.agents?.runOnboarding ?? ((input) => runOnboardingAgent(input, onboardingDeps)),
    onboarding: stores.onboarding,
    onboardingTexts: boot.onboardingTexts,
  };
  return createApp(approvalDeps, [
    ...createIntakeRoutes(intakeDeps),
    // chat-endpoint rule 25: one IntakeDeps for both, so chat's records reach the queue.
    ...createChatRoutes({
      intake: intakeDeps,
      conversations: stores.conversations,
      texts: boot.chatTexts,
    }),
    // spec onboarding-api, rules 1, 19: create, list, read and task status.
    ...createOnboardingRoutes({
      directory: stores.directory,
      onboarding: stores.onboarding,
      approvals: stores.approvals,
      messages: stores.leaveRequests, // the creator can read the create trace (D-9)
      audit: stores.audit,
      clock,
      idGen,
      idempotency: stores.idempotency,
      policy: boot.onboardingPolicy,
      evaluateOnboarding,
      toIsoDate,
      runOnboardingNotes:
        parts.agents?.runOnboardingNotes ??
        ((input, tasks) => runOnboardingNotesAgent(input, tasks, onboardingDeps)),
      onboardingTexts: boot.onboardingTexts,
      intakeTexts: boot.intakeTexts,
    }),
  ]);
}
