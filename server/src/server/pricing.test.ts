// specs/agent-metrics.md AT-4 (rule 3: boot reads pricing) and AT-5 (rule 4: startServer refuses an
// unpriced shipped model). New file next to boot.ts and start.ts; the existing start.test.ts and
// boot tests are untouched.
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pricing } from '../lib/cost.js';
import { loadLeavePolicy } from '../policies/load.js';
import type { ServerStores } from './app.js';
import {
  defaultQaBootPaths,
  loadBootFiles,
  SHIPPED_AGENT_CONFIGS,
  unpricedModels,
} from './boot.js';
import { startServer } from './start.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const PROMPTS_ROOT = join(REPO_ROOT, 'prompts');
const POLICY_PATH = join(REPO_ROOT, 'policies', 'leave', 'v1.yaml');
const VALID_ENV = {
  MONGODB_URI: 'mongodb://localhost:27017/hr_test',
  ANTHROPIC_API_KEY: 'TEST-KEY-CANARY-0000',
};

const pricingOf = (models: string[]) =>
  Pricing.parse({
    version: 1,
    asOf: '2026-10-01',
    currency: 'USD',
    models: Object.fromEntries(
      models.map((m) => [m, { inputPerMTok: 1234.5, outputPerMTok: 6789.5 }]),
    ),
  });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-pricing-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writePricing = (name: string, body: unknown): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

describe('agent-metrics AT-4: loadBootFiles reads pricing', () => {
  it('AT-4: a valid pricing file is returned parsed as boot.pricing', async () => {
    const p = writePricing('ok.yaml', {
      version: 1,
      asOf: '2026-10-01',
      currency: 'USD',
      models: { 'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    const boot = await loadBootFiles(PROMPTS_ROOT, {
      ...defaultQaBootPaths(PROMPTS_ROOT),
      pricingPath: p,
    });
    expect(boot.pricing.models['claude-haiku-5-5']).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(Object.keys(boot.pricing.models)).toEqual(['claude-haiku-5-5']); // no coverage check here
  });

  it('AT-4: a missing path rejects naming the path and no price', async () => {
    const p = join(dir, 'missing.yaml');
    const err = await loadBootFiles(PROMPTS_ROOT, {
      ...defaultQaBootPaths(PROMPTS_ROOT),
      pricingPath: p,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(p);
  });

  it('AT-4: currency EUR rejects with the path and without the price', async () => {
    const p = writePricing('eur.yaml', {
      version: 1,
      asOf: '2026-10-01',
      currency: 'EUR',
      models: { 'claude-haiku-5-5': { inputPerMTok: 7777.25, outputPerMTok: 8888.25 } },
    });
    const err = await loadBootFiles(PROMPTS_ROOT, {
      ...defaultQaBootPaths(PROMPTS_ROOT),
      pricingPath: p,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(p);
    expect((err as Error).message).not.toContain('7777');
    expect((err as Error).message).not.toContain('8888');
  });
});

describe('agent-metrics AT-5: SHIPPED_AGENT_CONFIGS and unpricedModels', () => {
  it('AT-5: the shipped configs are the five agents in order', () => {
    expect(SHIPPED_AGENT_CONFIGS.map((c) => c.agentId)).toEqual([
      'orchestrator',
      'leave',
      'policy_qa',
      'onboarding',
      'onboarding_notes',
    ]);
  });

  it('AT-5: unpricedModels lists each config whose model has no entry, and none when covered', () => {
    const all = SHIPPED_AGENT_CONFIGS.map((c) => c.model);
    expect(unpricedModels(pricingOf(all), SHIPPED_AGENT_CONFIGS)).toEqual([]);
    const first = SHIPPED_AGENT_CONFIGS[0];
    if (first === undefined) throw new Error('no configs');
    const missing = unpricedModels(
      pricingOf(all.filter((m) => m !== first.model)),
      SHIPPED_AGENT_CONFIGS,
    );
    expect(missing).toContainEqual({ agentId: first.agentId, model: first.model });
  });
});

describe('agent-metrics AT-5: startServer refuses an unpriced shipped model', () => {
  let realBoot: Awaited<ReturnType<typeof loadBootFiles>>;
  beforeAll(async () => {
    realBoot = await loadBootFiles(PROMPTS_ROOT);
  });

  function harness(pricing: Pricing, argv: string[] = []) {
    const calls = { boot: 0, model: 0, connect: 0, listen: 0 };
    const err: string[] = [];
    const out: string[] = [];
    const handlers: (() => void)[] = [];
    const done = startServer({
      argv,
      env: VALID_ENV,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      loadPolicy: () => loadLeavePolicy(POLICY_PATH),
      loadBootFiles: () => {
        calls.boot += 1;
        return Promise.resolve({ ...realBoot, pricing });
      },
      createModel: () => {
        calls.model += 1;
        return { create: () => Promise.reject(new Error('model must not be called')) };
      },
      connect: () => {
        calls.connect += 1;
        return Promise.resolve({
          stores: {} as ServerStores,
          countOrphans: () => Promise.resolve(0),
          close: () => Promise.resolve(),
        });
      },
      buildApp: () => express(),
      listen: () => {
        calls.listen += 1;
        return Promise.resolve({ close: () => Promise.resolve(), forceClose: vi.fn() });
      },
      onSignal: (_s, h) => {
        handlers.push(h);
      },
      graceMs: 1000,
    });
    return { done, calls, err, out, handlers };
  }

  it.each([0, 1, 2, 3, 4])(
    'AT-5: config %i with no pricing entry gives exit 1, a scrubbed line, and no model, connect or listen',
    async (i) => {
      const cfg = SHIPPED_AGENT_CONFIGS[i];
      if (cfg === undefined) throw new Error('no config');
      const models = SHIPPED_AGENT_CONFIGS.map((c) => c.model).filter((m) => m !== cfg.model);
      const h = harness(pricingOf(models));
      expect(await h.done).toBe(1);
      const text = h.err.join('\n');
      expect(text).toContain(
        `startup: pricing has no entry for model ${cfg.model} (agent ${cfg.agentId})`,
      );
      expect(text).not.toContain('1234.5');
      expect(h.calls.model).toBe(0);
      expect(h.calls.connect).toBe(0);
      expect(h.calls.listen).toBe(0);
    },
  );

  it('AT-5: full pricing proceeds to listen', async () => {
    const h = harness(pricingOf(SHIPPED_AGENT_CONFIGS.map((c) => c.model)));
    for (let i = 0; i < 400 && h.calls.listen === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(h.calls.listen).toBe(1);
    // One signal: SIGTERM and SIGINT share a handler, and a second signal forces exit 1.
    const [sigterm] = h.handlers;
    if (sigterm === undefined) throw new Error('no signal handler');
    sigterm();
    expect(await h.done).toBe(0);
  });

  it('AT-5: --check-policy returns 0 without calling loadBootFiles', async () => {
    const h = harness(pricingOf([]), ['--check-policy']);
    expect(await h.done).toBe(0);
    expect(h.calls.boot).toBe(0);
  });
});
