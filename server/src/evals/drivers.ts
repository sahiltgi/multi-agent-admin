// Drivers (spec eval-runner, rule 6; D-2): the production stack, unmodified. The orchestrator and
// the Leave Agent are called directly; policy_qa and onboarding go through the real app, called
// in-process at the case's endpoint. No socket is opened.
import { buildLeaveAgentDeps } from '../agents/leave/deps.js';
import { runLeaveAgent } from '../agents/leave/run.js';
import { classifyMessage } from '../agents/orchestrator/classify.js';
import { createProductionRegistry } from '../agents/registry.js';
import type { RuntimeDeps, Scheduler } from '../agents/runtime.js';
import type { ModelClient } from '../agents/schemas.js';
import { detectInjectionHeuristic } from '../agents/untrusted.js';
import type { loadLeavePolicy } from '../policies/load.js';
import { buildApp } from '../server/app.js';
import type { BootFiles } from '../server/boot.js';
import { inject } from './inject.js';
import type { LoadedCase } from './load.js';
import type { RunOutput } from './observe.js';
import type { CaseWorld } from './world.js';

export interface DriverContext {
  boot: BootFiles;
  policy: ReturnType<typeof loadLeavePolicy>;
  world: CaseWorld;
  model: ModelClient;
  scheduler: Scheduler;
}

function runtimeDeps(ctx: DriverContext): RuntimeDeps {
  return {
    model: ctx.model,
    registry: createProductionRegistry(ctx.boot.descriptions),
    prompts: ctx.boot.prompts,
    audit: ctx.world.stores.audit,
    clock: ctx.world.clock,
    scheduler: ctx.scheduler,
    idGen: ctx.world.idGen,
    detectInjection: detectInjectionHeuristic,
  };
}

/** Runs one case. Throws for an endpoint a single message can't drive (`approvals`, `onboarding`). */
export async function drive(c: LoadedCase, ctx: DriverContext): Promise<RunOutput> {
  const { boot, world } = ctx;
  switch (c.agent) {
    case 'orchestrator': {
      const input = {
        requestId: world.idGen(),
        agentId: 'orchestrator' as const,
        actor: c.actor,
        userText: c.userText,
      };
      const decision = await classifyMessage(input, {
        ...runtimeDeps(ctx),
        messages: boot.orchestratorMessages,
      });
      return { agent: 'orchestrator', decision };
    }
    case 'leave': {
      const deps = buildLeaveAgentDeps({
        runtime: runtimeDeps(ctx),
        data: world.stores.leaveData,
        policy: ctx.policy,
        texts: boot.leaveTexts,
        toolDescriptions: boot.leaveToolDescriptions,
      });
      const input = {
        requestId: world.idGen(),
        agentId: 'leave' as const,
        actor: c.actor,
        userText: c.userText,
      };
      return { agent: 'leave', result: await runLeaveAgent(input, deps) };
    }
    case 'policy_qa':
    case 'onboarding': {
      const endpoint = c.endpoint;
      if (endpoint !== 'messages' && endpoint !== 'chat') {
        throw new Error('endpoint is not drivable by a single message');
      }
      const app = buildApp({
        policy: ctx.policy,
        boot,
        stores: world.stores,
        model: ctx.model,
        clock: world.clock,
        scheduler: ctx.scheduler,
        idGen: world.idGen,
      });
      const response = await inject((req, res) => app(req, res), {
        url: endpoint === 'messages' ? '/messages' : '/chat',
        demoUser: c.actor.employeeId,
        body: endpoint === 'messages' ? { text: c.userText } : { message: c.userText },
      });
      return { agent: c.agent, endpoint, response };
    }
  }
}
