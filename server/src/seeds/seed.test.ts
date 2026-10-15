import { describe, expect, it } from 'vitest';
import { SeedSummary } from '../domain/schemas.js';
import { fixtures } from './fixtures.js';
import { runSeed, SEED_COLLECTIONS, type SeedCollection, type SeedWriter } from './seed.js';

const GOOD_URI = 'mongodb://localhost:27017/hr';
const EXPECTED_COUNTS = {
  teams: 3,
  employees: 20,
  leaveBalances: 120,
  holidays: 6,
  leaveRequests: 5,
};

interface Harness {
  calls: string[];
  replaced: SeedCollection[];
  stdout: string[];
  stderr: string[];
  writer: SeedWriter;
  deps: (
    env: Readonly<Record<string, string | undefined>>,
    fx?: Readonly<Record<SeedCollection, readonly unknown[]>>,
  ) => Parameters<typeof runSeed>[0];
}

function harness(opts: { connectError?: Error; failReplaceAt?: number } = {}): Harness {
  const calls: string[] = [];
  const replaced: SeedCollection[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writer: SeedWriter = {
    connect: () => {
      calls.push('connect');
      if (opts.connectError) return Promise.reject(opts.connectError);
      return Promise.resolve();
    },
    replaceAll: (collection) => {
      calls.push('replaceAll');
      replaced.push(collection);
      if (opts.failReplaceAt !== undefined && replaced.length === opts.failReplaceAt) {
        return Promise.reject(new Error('write failed'));
      }
      return Promise.resolve();
    },
    disconnect: () => {
      calls.push('disconnect');
      return Promise.resolve();
    },
  };
  return {
    calls,
    replaced,
    stdout,
    stderr,
    writer,
    deps: (env, fx = fixtures) => ({
      env,
      fixtures: fx,
      writer,
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    }),
  };
}

describe('runSeed', () => {
  it('AT-19: an invalid fixture exits non-zero with zero writer calls', async () => {
    const h = harness();
    const bad = {
      ...fixtures,
      employees: fixtures.employees.map((e, i) => (i === 3 ? { ...e, role: 'superuser' } : e)),
    };
    const code = await runSeed(h.deps({ MONGODB_URI: GOOD_URI }, bad));
    expect(code).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('AT-20: missing or empty MONGODB_URI exits non-zero, names the variable, no writer calls', async () => {
    for (const env of [{}, { MONGODB_URI: '' }]) {
      const h = harness();
      const code = await runSeed(h.deps(env));
      expect(code).not.toBe(0);
      expect(h.stderr.join('\n')).toContain('MONGODB_URI');
      expect(h.calls).toEqual([]);
    }
  });

  it('AT-20: the URI secret never appears in stdout or stderr', async () => {
    const uri = 'mongodb://user:pass-xyz@localhost:27017/hr';
    const ok = harness();
    await runSeed(ok.deps({ MONGODB_URI: uri }));
    const failing = harness({ connectError: new Error(`cannot connect to ${uri}`) });
    const code = await runSeed(failing.deps({ MONGODB_URI: uri }));
    expect(code).not.toBe(0);
    for (const h of [ok, failing]) {
      expect(h.stdout.join('\n')).not.toContain('pass-xyz');
      expect(h.stderr.join('\n')).not.toContain('pass-xyz');
    }
  });

  it('AT-30: production is refused before any writer call', async () => {
    const h = harness();
    const code = await runSeed(h.deps({ MONGODB_URI: GOOD_URI, NODE_ENV: 'production' }));
    expect(code).not.toBe(0);
    expect(h.stderr.join('\n')).toContain('production');
    expect(h.calls).toEqual([]);
  });

  it('AT-30: development run replaces every collection and prints a SeedSummary', async () => {
    const h = harness();
    const code = await runSeed(h.deps({ MONGODB_URI: GOOD_URI, NODE_ENV: 'development' }));
    expect(code).toBe(0);
    expect(h.replaced).toHaveLength(SEED_COLLECTIONS.length);
    expect([...h.replaced].sort()).toEqual([...SEED_COLLECTIONS].sort());
    const last = h.stdout[h.stdout.length - 1];
    expect(last).toBeDefined();
    const summary = SeedSummary.parse(JSON.parse(last ?? '{}'));
    expect(summary).toEqual(EXPECTED_COUNTS);
  });

  it('AT-31: a failed write exits non-zero, advises re-running, and disconnects', async () => {
    const h = harness({ failReplaceAt: 2 });
    const code = await runSeed(h.deps({ MONGODB_URI: GOOD_URI }));
    expect(code).not.toBe(0);
    expect(h.stderr.join('\n')).toContain('npm run seed');
    expect(h.calls).toContain('disconnect');
  });
});
