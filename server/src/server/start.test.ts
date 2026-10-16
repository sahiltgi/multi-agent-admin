// Acceptance tests for specs/mongo-persistence.md: AT-12, AT-13, AT-15, AT-17 (fake level),
// AT-18 (startup half), AT-21, AT-22. Module seams are D-18: startServer takes every step as a dep.
// All data is synthetic; the key and password below are canaries that must never be printed.
import express from 'express';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PolicyLoadError, loadLeavePolicy } from '../policies/load.js';
import type { ServerStores } from './app.js';
import { loadBootFiles } from './boot.js';
import { runServerProcess, startServer } from './start.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const POLICY_PATH = join(REPO_ROOT, 'policies', 'leave', 'v1.yaml');
const PROMPTS_ROOT = join(REPO_ROOT, 'prompts');

const PASSWORD = 'pw-canary-1';
const KEY = 'TEST-KEY-CANARY-0000';
const URI_WITH_PASSWORD = `mongodb://u:${PASSWORD}@localhost:27017/hr`;
const VALID_ENV = { MONGODB_URI: 'mongodb://localhost:27017/hr_test', ANTHROPIC_API_KEY: KEY };

type StartDeps = Parameters<typeof startServer>[0];
type Signal = 'SIGTERM' | 'SIGINT';
type Step = 'policy' | 'boot' | 'model' | 'connect' | 'app' | 'listen';
const STEPS: Step[] = ['policy', 'boot', 'model', 'connect', 'app', 'listen'];

let realBoot: Awaited<ReturnType<typeof loadBootFiles>>;
beforeAll(async () => {
  realBoot = await loadBootFiles(PROMPTS_ROOT);
});

interface Opts {
  env?: Record<string, string | undefined>;
  argv?: string[];
  orphans?: number;
  graceMs?: number;
  failAt?: Step;
  connectError?: Error;
  modelError?: Error;
  closeResult?: Promise<void>;
}

function makeHarness(opts: Opts = {}) {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const handlers: Record<Signal, (() => void)[]> = { SIGTERM: [], SIGINT: [] };
  const listenArgs: { port: number; host: string }[] = [];
  const counts = { close: 0, forceClose: 0 };

  const maybeFail = (step: Step): void => {
    if (opts.failAt === step) throw new Error('synthetic step failure');
  };

  const deps: StartDeps = {
    argv: opts.argv ?? [],
    env: opts.env ?? VALID_ENV,
    stdout: (line) => {
      out.push(line);
      log.push(`stdout:${line.trim()}`);
    },
    stderr: (line) => {
      err.push(line);
    },
    loadPolicy: (path) => {
      log.push('policy');
      if (opts.failAt === 'policy') {
        throw new PolicyLoadError({
          filePath: path,
          kind: 'read',
          issues: [{ path: [], message: 'cannot read file (ENOENT)' }],
        });
      }
      return loadLeavePolicy(POLICY_PATH);
    },
    loadBootFiles: () => {
      log.push('boot');
      if (opts.failAt === 'boot') return Promise.reject(new Error('synthetic step failure'));
      return Promise.resolve(realBoot);
    },
    createModel: () => {
      log.push('model');
      if (opts.modelError !== undefined) throw opts.modelError;
      maybeFail('model');
      return { create: () => Promise.reject(new Error('model must not be called')) };
    },
    connect: () => {
      log.push('connect');
      if (opts.connectError !== undefined) return Promise.reject(opts.connectError);
      if (opts.failAt === 'connect') return Promise.reject(new Error('synthetic step failure'));
      return Promise.resolve({
        stores: {} as ServerStores,
        countOrphans: () => Promise.resolve(opts.orphans ?? 0),
        close: () => {
          log.push('mongo.close');
          return Promise.resolve();
        },
      });
    },
    buildApp: () => {
      log.push('app');
      maybeFail('app');
      return express();
    },
    listen: (_app, port, host) => {
      log.push('listen');
      listenArgs.push({ port, host });
      if (opts.failAt === 'listen') return Promise.reject(new Error('synthetic step failure'));
      return Promise.resolve({
        close: () => {
          counts.close += 1;
          log.push('close');
          return opts.closeResult ?? Promise.resolve();
        },
        forceClose: () => {
          counts.forceClose += 1;
        },
      });
    },
    onSignal: (signal, handler) => {
      handlers[signal].push(handler);
    },
    graceMs: opts.graceMs ?? 5000,
  };

  const fire = (signal: Signal): void => {
    for (const h of handlers[signal]) h();
  };
  return { deps, log, out, err, handlers, listenArgs, counts, fire };
}
type Harness = ReturnType<typeof makeHarness>;

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  if (!cond()) throw new Error('condition not reached');
}

const stdoutAll = (h: Harness) => h.out.join('\n');
const stderrAll = (h: Harness) => h.err.join('\n');
const steps = (h: Harness) => h.log.filter((l) => !l.startsWith('stdout:'));

/** Starts, waits until the server is listening and ready, then sends SIGTERM and returns the code. */
async function runToShutdown(h: Harness): Promise<number> {
  const p = startServer(h.deps);
  await waitFor(() => h.log.includes('listen'));
  await waitFor(() => stdoutAll(h).includes('startup: ready'));
  await waitFor(() => h.handlers.SIGTERM.length > 0);
  h.fire('SIGTERM');
  return p;
}

/** The exit code, or 'pending' when the promise has not settled within the wait. */
async function settledWithin(p: Promise<number>, ms: number): Promise<number | 'pending'> {
  return Promise.race([
    p,
    new Promise<'pending'>((r) =>
      setTimeout(() => {
        r('pending');
      }, ms),
    ),
  ]);
}

describe('AT-12: ServerRuntimeEnv is the only env boundary (rule 9, D-5, D-6)', () => {
  it('AT-12: missing URI, bad PORT and missing key exit non-zero naming each variable, and open nothing', async () => {
    const h = makeHarness({ env: { PORT: '70000' } });
    const code = await startServer(h.deps);
    expect(code).not.toBe(0);
    const msg = stderrAll(h);
    expect(msg).toContain('MONGODB_URI');
    expect(msg).toContain('PORT');
    expect(msg).toContain('ANTHROPIC_API_KEY');
    expect(msg).not.toContain('70000');
    expect(steps(h)).not.toContain('connect');
    expect(steps(h)).not.toContain('listen');
    expect(stdoutAll(h)).not.toContain('startup: ready');
  });

  it.each(['0', '65536', '80a', ' 8080', ''])(
    'AT-12: PORT %j is rejected before any later step',
    async (port) => {
      const h = makeHarness({ env: { ...VALID_ENV, PORT: port } });
      const code = await startServer(h.deps);
      expect(code).not.toBe(0);
      expect(stderrAll(h)).toContain('PORT');
      expect(steps(h)).not.toContain('connect');
      expect(steps(h)).not.toContain('listen');
    },
  );

  it.each([undefined, ''])(
    'AT-12: ANTHROPIC_API_KEY %j fails naming the variable (D-6)',
    async (key) => {
      const h = makeHarness({
        env: { MONGODB_URI: VALID_ENV.MONGODB_URI, ANTHROPIC_API_KEY: key },
      });
      const code = await startServer(h.deps);
      expect(code).not.toBe(0);
      expect(stderrAll(h)).toContain('ANTHROPIC_API_KEY');
      expect(steps(h)).not.toContain('connect');
      expect(steps(h)).not.toContain('listen');
    },
  );

  it('AT-12: an invalid MONGODB_URI fails naming the variable and never its value', async () => {
    const h = makeHarness({ env: { ...VALID_ENV, MONGODB_URI: 'not-a-uri-canary' } });
    const code = await startServer(h.deps);
    expect(code).not.toBe(0);
    expect(stderrAll(h)).toContain('MONGODB_URI');
    expect(stderrAll(h)).not.toContain('not-a-uri-canary');
    expect(steps(h)).not.toContain('connect');
  });

  it('AT-12 (D-5): PORT defaults to 3000 and the bind address is 127.0.0.1', async () => {
    const h = makeHarness();
    expect(await runToShutdown(h)).toBe(0);
    expect(h.listenArgs).toEqual([{ port: 3000, host: '127.0.0.1' }]);
  });

  it('AT-12 (D-5): an explicit PORT is passed to listen as a number', async () => {
    const h = makeHarness({ env: { ...VALID_ENV, PORT: '8080' } });
    expect(await runToShutdown(h)).toBe(0);
    expect(h.listenArgs).toEqual([{ port: 8080, host: '127.0.0.1' }]);
  });

  it('AT-12: neither the password nor the key appears in stdout or stderr on a full run', async () => {
    const h = makeHarness({ env: { MONGODB_URI: URI_WITH_PASSWORD, ANTHROPIC_API_KEY: KEY } });
    expect(await runToShutdown(h)).toBe(0);
    for (const text of [stdoutAll(h), stderrAll(h)]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(URI_WITH_PASSWORD);
    }
  });
});

describe('AT-13: startup order (rule 10)', () => {
  it('AT-13: policy, prompt files, model client, connect, app, listen, then startup: ready', async () => {
    const h = makeHarness();
    expect(await runToShutdown(h)).toBe(0);
    expect(steps(h).filter((s) => STEPS.includes(s as Step))).toEqual(STEPS);
    expect(h.log.indexOf('listen')).toBeLessThan(h.log.indexOf('stdout:startup: ready'));
    expect(stdoutAll(h).match(/startup: ready/g)).toHaveLength(1);
  });

  it.each(STEPS)(
    'AT-13: a failure at %s stops later steps, opens no port and prints no ready line',
    async (failAt) => {
      const h = makeHarness({ failAt });
      const code = await startServer(h.deps);
      expect(code).not.toBe(0);
      const ran = steps(h);
      const later = STEPS.slice(STEPS.indexOf(failAt) + 1);
      for (const s of later) expect(ran, s).not.toContain(s);
      expect(ran).toContain(failAt);
      expect(stdoutAll(h)).not.toContain('startup: ready');
      expect(stderrAll(h).trim()).not.toBe('');
      expect(stderrAll(h)).not.toMatch(/^\s+at /m);
    },
  );

  it('AT-13: an env failure comes right after the policy step and nothing else runs', async () => {
    const h = makeHarness({ env: {} });
    expect(await startServer(h.deps)).not.toBe(0);
    expect(steps(h)).toEqual(['policy']);
  });

  it('AT-13: a policy load failure runs nothing else, even with an invalid env', async () => {
    const h = makeHarness({ env: {}, failAt: 'policy' });
    expect(await startServer(h.deps)).not.toBe(0);
    expect(steps(h)).toEqual(['policy']);
    expect(stderrAll(h)).toContain('Leave policy failed to load');
  });
});

describe('AT-15: production is refused (rule 11)', () => {
  it('AT-15: NODE_ENV=production exits non-zero mentioning production and opens nothing', async () => {
    const h = makeHarness({ env: { ...VALID_ENV, NODE_ENV: 'production' } });
    const code = await startServer(h.deps);
    expect(code).not.toBe(0);
    expect(stderrAll(h)).toContain('production');
    const ran = steps(h);
    for (const s of ['boot', 'model', 'connect', 'app', 'listen']) expect(ran, s).not.toContain(s);
    expect(stdoutAll(h)).not.toContain('startup: ready');
  });

  it.each(['Production', ' production', 'PRODUCTION\n'])(
    'AT-15: NODE_ENV %j is refused too (case and whitespace are ignored)',
    async (nodeEnv) => {
      const h = makeHarness({ env: { ...VALID_ENV, NODE_ENV: nodeEnv } });
      expect(await startServer(h.deps)).not.toBe(0);
      expect(stderrAll(h)).toContain('production');
      expect(steps(h)).not.toContain('connect');
      expect(steps(h)).not.toContain('listen');
    },
  );
});

describe('AT-17: graceful shutdown (rule 13), fake level', () => {
  it('AT-17: SIGTERM stops listening, waits for in-flight work, closes Mongo after it, exits 0', async () => {
    let release: () => void = () => undefined;
    const closeResult = new Promise<void>((r) => {
      release = r;
    });
    const h = makeHarness({ closeResult });
    let code: number | undefined;
    const p = startServer(h.deps).then((c) => {
      code = c;
      return c;
    });
    await waitFor(() => stdoutAll(h).includes('startup: ready'));
    await waitFor(() => h.handlers.SIGTERM.length > 0);
    h.fire('SIGTERM');
    await waitFor(() => h.counts.close === 1);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(steps(h)).not.toContain('mongo.close');
    expect(code).toBeUndefined();
    release();
    expect(await p).toBe(0);
    expect(steps(h)).toContain('mongo.close');
    expect(steps(h).indexOf('close')).toBeLessThan(steps(h).indexOf('mongo.close'));
    expect(h.counts.forceClose).toBe(0);
  });

  it('AT-17: SIGINT behaves like SIGTERM', async () => {
    const h = makeHarness();
    const p = startServer(h.deps);
    await waitFor(() => stdoutAll(h).includes('startup: ready'));
    await waitFor(() => h.handlers.SIGINT.length > 0);
    h.fire('SIGINT');
    expect(await p).toBe(0);
    expect(steps(h).indexOf('close')).toBeLessThan(steps(h).indexOf('mongo.close'));
  });

  it('AT-17: a second signal exits non-zero without waiting and force-closes', async () => {
    const h = makeHarness({ closeResult: new Promise<void>(() => undefined) });
    const p = startServer(h.deps);
    await waitFor(() => stdoutAll(h).includes('startup: ready'));
    await waitFor(() => h.handlers.SIGTERM.length > 0);
    h.fire('SIGTERM');
    await waitFor(() => h.counts.close === 1);
    expect(await settledWithin(p, 50)).toBe('pending');
    h.fire('SIGTERM');
    const code = await settledWithin(p, 2000);
    expect(code).not.toBe('pending');
    expect(code).not.toBe(0);
    expect(h.counts.forceClose).toBeGreaterThan(0);
  });

  it('AT-17: once the grace period passes with requests still open, the exit code is non-zero', async () => {
    const h = makeHarness({ closeResult: new Promise<void>(() => undefined), graceMs: 20 });
    const p = startServer(h.deps);
    await waitFor(() => stdoutAll(h).includes('startup: ready'));
    await waitFor(() => h.handlers.SIGTERM.length > 0);
    h.fire('SIGTERM');
    const code = await settledWithin(p, 2000);
    expect(code).not.toBe('pending');
    expect(code).not.toBe(0);
  });
});

describe('AT-17: the process exits at once on a forced stop (rule 13)', () => {
  it('AT-17: a second signal calls exit with a non-zero code', async () => {
    const h = makeHarness({ closeResult: new Promise<void>(() => undefined) });
    const exits: number[] = [];
    const p = runServerProcess(h.deps, (code) => {
      exits.push(code);
    });
    await waitFor(() => stdoutAll(h).includes('startup: ready'));
    h.fire('SIGTERM');
    await waitFor(() => h.counts.close === 1);
    h.fire('SIGTERM');
    const code = await p;
    expect(code).not.toBe(0);
    expect(exits).toEqual([code]);
  });

  it('AT-17: a clean shutdown returns 0 and does not force an exit', async () => {
    const h = makeHarness();
    const exits: number[] = [];
    const p = runServerProcess(h.deps, (code) => {
      exits.push(code);
    });
    await waitFor(() => stdoutAll(h).includes('startup: ready'));
    h.fire('SIGTERM');
    expect(await p).toBe(0);
    expect(exits).toEqual([]);
  });
});

describe('AT-18: secrets are never printed (rule 14), startup half', () => {
  it('AT-18: a connect error holding the full URI and password is scrubbed from stdout and stderr', async () => {
    const h = makeHarness({
      env: { MONGODB_URI: URI_WITH_PASSWORD, ANTHROPIC_API_KEY: KEY },
      connectError: new Error(
        `connection to ${URI_WITH_PASSWORD} failed: auth failed for ${PASSWORD}`,
      ),
    });
    const code = await startServer(h.deps);
    expect(code).not.toBe(0);
    expect(steps(h)).not.toContain('listen');
    expect(stderrAll(h).trim()).not.toBe('');
    for (const text of [stdoutAll(h), stderrAll(h)]) {
      expect(text).not.toContain(URI_WITH_PASSWORD);
      expect(text).not.toContain(PASSWORD);
    }
  });

  it('AT-18: a percent-encoded password in a connect error is scrubbed as well', async () => {
    const encoded = 'pw%2Fcanary%2F2';
    const h = makeHarness({
      env: { MONGODB_URI: `mongodb://u:${encoded}@localhost:27017/hr`, ANTHROPIC_API_KEY: KEY },
      connectError: new Error('auth failed for pw/canary/2 and pw%2Fcanary%2F2'),
    });
    expect(await startServer(h.deps)).not.toBe(0);
    for (const text of [stdoutAll(h), stderrAll(h)]) {
      expect(text).not.toContain('pw/canary/2');
      expect(text).not.toContain(encoded);
    }
  });

  it('AT-18: a model-client error holding the API key is scrubbed from stdout and stderr', async () => {
    const h = makeHarness({ modelError: new Error(`invalid x-api-key ${KEY}`) });
    const code = await startServer(h.deps);
    expect(code).not.toBe(0);
    expect(stderrAll(h).trim()).not.toBe('');
    for (const text of [stdoutAll(h), stderrAll(h)]) expect(text).not.toContain(KEY);
  });
});

describe('AT-21: orphan count at startup (D-3)', () => {
  const extraLines = async (orphans: number): Promise<{ extra: string[]; listened: boolean }> => {
    const base = makeHarness({ orphans: 0 });
    await runToShutdown(base);
    const baseLines = new Set(base.out.map((l) => l.trim()));
    const h = makeHarness({ orphans });
    await runToShutdown(h);
    return {
      extra: h.out.map((l) => l.trim()).filter((l) => l !== '' && !baseLines.has(l)),
      listened: h.log.includes('listen'),
    };
  };

  it('AT-21: countOrphans resolving 2 prints one line containing 2 and still listens', async () => {
    const { extra, listened } = await extraLines(2);
    expect(listened).toBe(true);
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain('2');
  });

  it('AT-21: countOrphans resolving 0 prints no orphan line', async () => {
    const { extra, listened } = await extraLines(0);
    expect(listened).toBe(true);
    expect(extra).toEqual([]);
  });
});

describe('AT-21: a failed orphan count never blocks startup (D-3)', () => {
  it('AT-21: countOrphans rejecting logs one scrubbed line and still listens', async () => {
    const h = makeHarness({ env: { MONGODB_URI: URI_WITH_PASSWORD, ANTHROPIC_API_KEY: KEY } });
    const connect = h.deps.connect;
    h.deps.connect = async (uri) => {
      const handle = await connect(uri);
      return {
        ...handle,
        countOrphans: () => Promise.reject(new Error(`aggregate failed on ${URI_WITH_PASSWORD}`)),
      };
    };
    expect(await runToShutdown(h)).toBe(0);
    expect(h.log).toContain('listen');
    expect(stderrAll(h)).toContain('orphaned');
    expect(stderrAll(h)).not.toContain(PASSWORD);
  });
});

describe('AT-22: --check-policy (D-11)', () => {
  it('AT-22: loads the policy, prints the policy line and startup: ready, resolves 0, calls no later step', async () => {
    const h = makeHarness({ argv: ['--check-policy'], env: {} });
    const code = await startServer(h.deps);
    expect(code).toBe(0);
    expect(steps(h)).toEqual(['policy']);
    expect(stdoutAll(h)).toContain('startup: ready');
    const policyLines = h.out.filter((l) => /[a-f0-9]{64}/.test(l) && l.includes('v1'));
    expect(policyLines).toHaveLength(1);
    expect(stderrAll(h)).toBe('');
  });

  it('AT-22: a full-env check run still touches nothing but the policy', async () => {
    const h = makeHarness({ argv: ['--check-policy'] });
    expect(await startServer(h.deps)).toBe(0);
    expect(steps(h)).toEqual(['policy']);
    expect(h.handlers.SIGTERM).toHaveLength(0);
    expect(h.handlers.SIGINT).toHaveLength(0);
  });

  it('AT-22: a policy load failure under --check-policy exits non-zero without ready', async () => {
    const h = makeHarness({ argv: ['--check-policy'], env: {}, failAt: 'policy' });
    expect(await startServer(h.deps)).not.toBe(0);
    expect(stdoutAll(h)).not.toContain('startup: ready');
    expect(steps(h)).toEqual(['policy']);
  });

  it('AT-22: an invalid LEAVE_POLICY_PATH still fails naming the variable', async () => {
    const h = makeHarness({ argv: ['--check-policy'], env: { LEAVE_POLICY_PATH: '' } });
    expect(await startServer(h.deps)).not.toBe(0);
    expect(stderrAll(h)).toContain('LEAVE_POLICY_PATH');
    expect(stdoutAll(h)).not.toContain('startup: ready');
  });
});
