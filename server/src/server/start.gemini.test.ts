// Spec gemini-fallback: AT-2 (createModel once), AT-3 (server env) and AT-6 (resolved pricing check).
// Same injected-deps style as start.test.ts. Canary keys must never be printed.
import express from 'express';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLeavePolicy } from '../policies/load.js';
import type { ServerStores } from './app.js';
import { SHIPPED_AGENT_CONFIGS, loadBootFiles, unmappedModels } from './boot.js';
import { startServer } from './start.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const GM = 'gm-CANARY-0001';
const SK = 'sk-CANARY-0002';
const URI = 'mongodb://localhost:27017/hr_test';

type StartDeps = Parameters<typeof startServer>[0];
type Boot = Awaited<ReturnType<typeof loadBootFiles>>;

let realBoot: Boot;
beforeAll(async () => {
  realBoot = await loadBootFiles(join(REPO_ROOT, 'prompts'));
});

const priced = (models: string[]) => ({
  ...realBoot.pricing,
  models: Object.fromEntries(models.map((m) => [m, { inputPerMTok: 0, outputPerMTok: 0 }])),
});
const CLAUDE = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

function harness(env: Record<string, string | undefined>, models: string[] | null = null) {
  const calls = { boot: 0, model: 0, connect: 0, listen: 0 };
  const out: string[] = [];
  const err: string[] = [];
  const handlers: (() => void)[] = [];
  let bootError: Error | null = null;
  const deps: StartDeps = {
    argv: [],
    env,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    loadPolicy: () => loadLeavePolicy(join(REPO_ROOT, 'policies', 'leave', 'v1.yaml')),
    loadBootFiles: () => {
      calls.boot += 1;
      if (bootError) return Promise.reject(bootError);
      return Promise.resolve(models === null ? realBoot : { ...realBoot, pricing: priced(models) });
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
      return Promise.resolve({ close: () => Promise.resolve(), forceClose: () => undefined });
    },
    onSignal: (_s, h) => {
      handlers.push(h);
    },
    graceMs: 1000,
  };
  const failBootWith = (e: Error): void => {
    bootError = e;
  };
  /** Starts, and if the server gets as far as listening, stops it with a signal. */
  const runUntilStopped = async (): Promise<number> => {
    const p = startServer(deps);
    const done = await Promise.race([
      p,
      vi_waitFor(() => handlers.length > 0).then(() => 'listening' as const),
    ]);
    if (done === 'listening') {
      handlers[0]?.();
      return p;
    }
    return done;
  };
  return { deps, calls, out, err, failBootWith, runUntilStopped };
}

async function vi_waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 5));
}

describe('AT-3: server env accepts either key', () => {
  it('AT-3: an empty Anthropic key with a Gemini key reaches createModel exactly once (AT-2)', async () => {
    const h = harness({ MONGODB_URI: URI, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: GM }, [
      'gemini-3.5-flash-lite',
    ]);
    const code = await h.runUntilStopped();
    expect(code).toBe(0);
    expect(h.calls.model).toBe(1);
    expect(h.calls.listen).toBe(1);
  });

  it('AT-3: neither key returns 1 naming both variables before boot files, model or connect', async () => {
    for (const env of [
      { MONGODB_URI: URI },
      { MONGODB_URI: URI, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' },
    ]) {
      const h = harness(env);
      expect(await startServer(h.deps)).toBe(1);
      const text = h.err.join('\n');
      expect(text).toContain('Invalid server environment: ');
      expect(text).toContain('ANTHROPIC_API_KEY');
      expect(text).toContain('GEMINI_API_KEY');
      expect(h.calls).toMatchObject({ boot: 0, model: 0, connect: 0, listen: 0 });
    }
  });

  it('AT-3: a boot failure that echoes the Gemini key is scrubbed', async () => {
    const h = harness({ MONGODB_URI: URI, GEMINI_API_KEY: GM });
    h.failBootWith(new Error(`prompt read failed for ${GM}`));
    expect(await startServer(h.deps)).toBe(1);
    expect(h.err.join('\n')).not.toContain(GM);
    expect(h.out.join('\n')).not.toContain(GM);
  });

  it('AT-3: both keys set scrubs the Gemini key too', async () => {
    const h = harness({ MONGODB_URI: URI, ANTHROPIC_API_KEY: SK, GEMINI_API_KEY: GM });
    h.failBootWith(new Error(`failed ${GM} and ${SK}`));
    expect(await startServer(h.deps)).toBe(1);
    const text = h.err.join('\n');
    expect(text).not.toContain(GM);
    expect(text).not.toContain(SK);
  });
});

describe('AT-6: unmappedModels (pure helper in boot.ts)', () => {
  it('AT-6: gemini with a claude-unknown config returns that config as unmapped', () => {
    expect(unmappedModels('gemini', [{ agentId: 'leave', model: 'claude-unknown' }])).toEqual([
      { agentId: 'leave', model: 'claude-unknown' },
    ]);
  });

  it('AT-6: gemini with the shipped configs returns nothing', () => {
    expect(unmappedModels('gemini', SHIPPED_AGENT_CONFIGS)).toEqual([]);
  });

  it('AT-6: anthropic never reports an unmapped model', () => {
    expect(unmappedModels('anthropic', [{ agentId: 'leave', model: 'claude-unknown' }])).toEqual(
      [],
    );
  });
});

describe('AT-6: startup checks resolved model ids', () => {
  it('AT-6: Gemini env with only claude pricing returns 1 naming the Gemini model and agents, no createModel', async () => {
    const h = harness({ MONGODB_URI: URI, GEMINI_API_KEY: GM }, CLAUDE);
    expect(await startServer(h.deps)).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('gemini-3.5-flash-lite');
    for (const agent of ['orchestrator', 'leave', 'policy_qa', 'onboarding']) {
      expect(text).toContain(agent);
    }
    expect(h.calls.model).toBe(0);
    expect(h.calls.connect).toBe(0);
  });

  it('AT-6: Gemini env with a zero-priced Gemini entry proceeds to listen', async () => {
    const h = harness({ MONGODB_URI: URI, GEMINI_API_KEY: GM }, ['gemini-3.5-flash-lite']);
    expect(await h.runUntilStopped()).toBe(0);
    expect(h.calls.listen).toBe(1);
  });

  it('AT-6: Anthropic env with only claude pricing proceeds', async () => {
    const h = harness({ MONGODB_URI: URI, ANTHROPIC_API_KEY: SK }, CLAUDE);
    expect(await h.runUntilStopped()).toBe(0);
    expect(h.calls.listen).toBe(1);
  });
});
