// Spec e2e-demo, rules 4, 5, 7, 8, 9 and 21 (AT-13 to AT-22, AT-26). The e2e entry point runs with
// every dependency injected: no MongoDB, network, browser or model is touched.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelClient } from '../agents/schemas.js';
import type { MongoHandle } from '../persistence/mongo/connect.js';
import type { ServerParts } from '../server/app.js';
import type { StartDeps } from '../server/start.js';
import mongoose from 'mongoose';
import { REPLAY_ONLY_KEY, deriveE2eUri, dropE2eDatabase, runE2e, withGuardedDrop } from './cli.js';

type E2eDeps = Parameters<typeof runE2e>[1];

const BASE_URI = 'mongodb://u:p@localhost:27017/hr?authSource=admin';
const HEX = 'abc123abc123';

const fakeModel: ModelClient = { create: () => Promise.resolve({}) };

interface Harness {
  deps: E2eDeps;
  out: string[];
  err: string[];
  seed: ReturnType<typeof vi.fn<(uri: string) => Promise<number>>>;
  dropDatabase: ReturnType<typeof vi.fn<(uri: string) => Promise<void>>>;
  createAnthropicClient: ReturnType<
    typeof vi.fn<(env: Record<string, string | undefined>) => ModelClient>
  >;
  runServerProcess: ReturnType<typeof vi.fn<(d: StartDeps) => Promise<number>>>;
  connect: ReturnType<typeof vi.fn<(uri: string) => Promise<MongoHandle>>>;
  buildApp: ReturnType<typeof vi.fn<(parts: ServerParts) => Express>>;
}

function harness(over: Partial<E2eDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const seed = vi.fn<(uri: string) => Promise<number>>(() => Promise.resolve(0));
  const dropDatabase = vi.fn<(uri: string) => Promise<void>>(() => Promise.resolve());
  const createAnthropicClient = vi.fn<(env: Record<string, string | undefined>) => ModelClient>(
    () => fakeModel,
  );
  const runServerProcess = vi.fn<(d: StartDeps) => Promise<number>>(() => Promise.resolve(0));
  const connect = vi.fn<(uri: string) => Promise<MongoHandle>>(() =>
    Promise.reject(new Error('connect must not run')),
  );
  const buildApp = vi.fn<(parts: ServerParts) => Express>(() => ({}) as unknown as Express);
  const baseStartDeps: Omit<StartDeps, 'env' | 'createModel' | 'buildApp' | 'connect'> = {
    argv: [],
    stdout: () => undefined,
    stderr: () => undefined,
    loadPolicy: () => {
      throw new Error('loadPolicy must not run');
    },
    loadBootFiles: () => Promise.reject(new Error('loadBootFiles must not run')),
    listen: () => Promise.reject(new Error('listen must not run')),
    onSignal: () => undefined,
    graceMs: 1,
  };
  const deps: E2eDeps = {
    randomHex: () => HEX,
    seed,
    dropDatabase,
    createAnthropicClient,
    runServerProcess,
    baseStartDeps,
    connect,
    buildApp,
    stdout: (line: string) => {
      out.push(line);
    },
    stderr: (line: string) => {
      err.push(line);
    },
    recordingsDir: '/rec',
    ...over,
  };
  return {
    deps,
    out,
    err,
    seed,
    dropDatabase,
    createAnthropicClient,
    runServerProcess,
    connect,
    buildApp,
  };
}

const all = (h: Harness): string => [...h.out, ...h.err].join('\n');

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network is forbidden in e2e cli tests');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function expectNoWork(h: Harness): void {
  expect(h.seed).toHaveBeenCalledTimes(0);
  expect(h.connect).toHaveBeenCalledTimes(0);
  expect(h.createAnthropicClient).toHaveBeenCalledTimes(0);
  expect(h.runServerProcess).toHaveBeenCalledTimes(0);
}

describe('runE2e refusals', () => {
  it.each(['true', '1'])('AT-13: record mode with CI=%s exits 1 before any work', async (ci) => {
    const h = harness();
    const code = await runE2e(
      { E2E_MODEL: 'record', CI: ci, MONGODB_URI: BASE_URI, ANTHROPIC_API_KEY: 'sk-CANARY' },
      h.deps,
    );
    expect(code).toBe(1);
    expectNoWork(h);
    expect(all(h)).toContain('CI');
    expect(all(h)).not.toContain('sk-CANARY');
  });

  it('AT-15: record mode without a key exits 1 naming ANTHROPIC_API_KEY', async () => {
    const h = harness();
    const code = await runE2e({ E2E_MODEL: 'record', MONGODB_URI: BASE_URI }, h.deps);
    expect(code).toBe(1);
    expectNoWork(h);
    expect(all(h)).toContain('ANTHROPIC_API_KEY');
  });

  it.each(['live', 'REPLAY'])('an E2E_MODEL of %s exits 1 (edge case)', async (mode) => {
    const h = harness();
    expect(await runE2e({ E2E_MODEL: mode, MONGODB_URI: BASE_URI }, h.deps)).toBe(1);
    expectNoWork(h);
  });

  it('a missing MONGODB_URI exits 1 naming the variable (edge case)', async () => {
    const h = harness();
    expect(await runE2e({}, h.deps)).toBe(1);
    expectNoWork(h);
    expect(all(h)).toContain('MONGODB_URI');
  });

  it.each(['production', 'PRODUCTION'])(
    'AT-21: NODE_ENV=%s exits 1 before any work',
    async (nodeEnv) => {
      const h = harness();
      const code = await runE2e({ NODE_ENV: nodeEnv, MONGODB_URI: BASE_URI }, h.deps);
      expect(code).toBe(1);
      expectNoWork(h);
      expect(h.dropDatabase).toHaveBeenCalledTimes(0);
    },
  );
});

describe('runE2e replay wiring', () => {
  it('AT-14: replay mode never builds an Anthropic client and swaps the key for replay-only', async () => {
    const h = harness();
    const code = await runE2e(
      { MONGODB_URI: BASE_URI, ANTHROPIC_API_KEY: 'sk-CANARY', PORT: '3100' },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.createAnthropicClient).toHaveBeenCalledTimes(0);
    expect(REPLAY_ONLY_KEY).toBe('replay-only');
    const startDeps = h.runServerProcess.mock.calls[0]?.[0];
    expect(startDeps?.env.ANTHROPIC_API_KEY).toBe('replay-only');
    expect(JSON.stringify(startDeps?.env)).not.toContain('sk-CANARY');
    expect(all(h)).not.toContain('sk-CANARY');
  });

  it('AT-16: the seed and the server get the same /hr_e2e_<12 hex> URI, rest of the URI unchanged', async () => {
    const h = harness();
    await runE2e({ MONGODB_URI: BASE_URI }, h.deps);
    const seeded = new URL(h.seed.mock.calls[0]?.[0] ?? 'x:');
    const served = h.runServerProcess.mock.calls[0]?.[0].env.MONGODB_URI;
    expect(seeded.pathname).toMatch(/^\/hr_e2e_[0-9a-f]{12}$/);
    expect(seeded.username).toBe('u');
    expect(seeded.password).toBe('p');
    expect(seeded.host).toBe('localhost:27017');
    expect(seeded.search).toBe('?authSource=admin');
    expect(served).toBe(seeded.toString());
    expect(deriveE2eUri(BASE_URI, HEX)).toBe(
      'mongodb://u:p@localhost:27017/hr_e2e_abc123abc123?authSource=admin',
    );
  });

  it.each(['xyz', 'hr', 'hr_test_abc123abc123', 'ABCDEF123456', 'abc123abc12'])(
    'AT-16: a derived name built from hex %s fails E2eDbName and exits 1 before any write',
    async (hex) => {
      const h = harness({ randomHex: () => hex });
      expect(await runE2e({ MONGODB_URI: BASE_URI }, h.deps)).toBe(1);
      expect(h.seed).toHaveBeenCalledTimes(0);
      expect(h.runServerProcess).toHaveBeenCalledTimes(0);
      expect(h.dropDatabase).toHaveBeenCalledTimes(0);
    },
  );

  it('AT-17: an unparseable MONGODB_URI exits 1 and is never printed', async () => {
    const h = harness();
    const code = await runE2e({ MONGODB_URI: 'CANARY-URI not a url' }, h.deps);
    expect(code).toBe(1);
    expect(h.seed).toHaveBeenCalledTimes(0);
    expect(all(h)).not.toContain('CANARY-URI');
  });

  it('AT-19: a failed seed exits 1, never starts the server and drops the DB once', async () => {
    const h = harness({ seed: () => Promise.resolve(1) });
    expect(await runE2e({ MONGODB_URI: BASE_URI }, h.deps)).toBe(1);
    expect(h.runServerProcess).toHaveBeenCalledTimes(0);
    expect(h.dropDatabase).toHaveBeenCalledTimes(1);
    expect(h.dropDatabase.mock.calls[0]?.[0]).toContain('/hr_e2e_abc123abc123');
  });

  it('AT-19: a server that fails before connect still drops the DB once', async () => {
    const h = harness({ runServerProcess: () => Promise.resolve(1) });
    expect(await runE2e({ MONGODB_URI: BASE_URI }, h.deps)).toBe(1);
    expect(h.dropDatabase).toHaveBeenCalledTimes(1);
  });

  it('AT-19: a failed drop is reported without the driver message and keeps the exit code', async () => {
    const h = harness({
      dropDatabase: () => Promise.reject(new Error('CANARY-DRIVER mongodb://u:p@host')),
    });
    expect(await runE2e({ MONGODB_URI: BASE_URI }, h.deps)).toBe(0);
    expect(all(h)).toContain('dropping the e2e database failed');
    expect(all(h)).not.toContain('CANARY-DRIVER');
  });

  it('AT-22: runServerProcess gets a buildApp that injects the e2e clock and keeps every other part', async () => {
    const h = harness();
    await runE2e({ MONGODB_URI: BASE_URI }, h.deps);
    const startDeps = h.runServerProcess.mock.calls[0]?.[0];
    const marker = {
      policy: {},
      boot: {},
      stores: {},
      model: fakeModel,
      clock: { nowMs: () => 0, nowIso: () => '1970-01-01T00:00:00.000Z' },
      scheduler: {},
      idGen: () => 'id',
    } as unknown as ServerParts;
    startDeps?.buildApp(marker);
    expect(h.buildApp).toHaveBeenCalledTimes(1);
    const received = h.buildApp.mock.calls[0]?.[0];
    expect(received?.clock.nowIso().slice(0, 10)).toBe('2026-11-09');
    expect(received?.clock).not.toBe(marker.clock);
    expect(received?.policy).toBe(marker.policy);
    expect(received?.boot).toBe(marker.boot);
    expect(received?.stores).toBe(marker.stores);
    expect(received?.model).toBe(marker.model);
    expect(received?.scheduler).toBe(marker.scheduler);
    expect(received?.idGen).toBe(marker.idGen);
  });
});

describe('withGuardedDrop', () => {
  function handleWith(order: string[]): MongoHandle {
    return {
      stores: {} as unknown as MongoHandle['stores'],
      countOrphans: () => Promise.resolve(0),
      close: () => {
        order.push('close');
        return Promise.resolve();
      },
    };
  }

  it('AT-18: close() drops the hr_e2e_ database first, then closes', async () => {
    const order: string[] = [];
    const dropDatabase = vi.fn<(uri: string) => Promise<void>>(() => {
      order.push('drop');
      return Promise.resolve();
    });
    const connect = withGuardedDrop(() => Promise.resolve(handleWith(order)), dropDatabase);
    const handle = await connect(deriveE2eUri(BASE_URI, HEX));
    await handle.close();
    expect(order).toEqual(['drop', 'close']);
  });

  it.each(['hr', 'hr_test_x'])('AT-18: never drops database %s', async (name) => {
    const order: string[] = [];
    const dropDatabase = vi.fn<(uri: string) => Promise<void>>(() => Promise.resolve());
    const connect = withGuardedDrop(() => Promise.resolve(handleWith(order)), dropDatabase);
    const handle = await connect(`mongodb://u:p@localhost:27017/${name}?authSource=admin`);
    await handle.close();
    expect(dropDatabase).toHaveBeenCalledTimes(0);
    expect(order).toEqual(['close']);
  });
});

describe('dropE2eDatabase', () => {
  it.each(['hr', 'hr_test_abc123abc123', 'hr_e2e_xyz', 'admin'])(
    'AT-18: never opens a connection for database %s',
    async (name) => {
      const spy = vi.spyOn(mongoose, 'createConnection');
      await dropE2eDatabase(`mongodb://u:p@localhost:27017/${name}?authSource=admin`);
      expect(spy).toHaveBeenCalledTimes(0);
      spy.mockRestore();
    },
  );
});

describe('static checks', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('AT-20: both CLIs import the writer from seeds/mongo-writer.ts', () => {
    expect(read('../seeds/cli.ts')).toMatch(/from '\.\/mongo-writer\.js'/);
    expect(read('./cli.ts')).toMatch(/from '\.\.\/seeds\/mongo-writer\.js'/);
  });

  it('AT-26: nothing under server/src/e2e imports the gate, registers a tool or builds a client outside the record branch', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
    expect(sources).toContain('cli.ts');
    for (const name of sources) {
      const text = read(`./${name}`);
      expect(text, name).not.toMatch(/from '[^']*\/gate\//);
      expect(text, name).not.toMatch(/registerTool|createProductionRegistry|approve_leave/);
      if (name !== 'cli.ts') {
        expect(text, name).not.toMatch(/createAnthropicClient\s*\(/);
      }
    }
    const cli = read('./cli.ts');
    const calls = cli.match(/createAnthropicClient\s*\(/g) ?? [];
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(cli).toMatch(/record/);
  });
});
