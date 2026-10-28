// Spec gemini-fallback: AT-27 (e2e replay is unaffected by a Gemini key). Every dep is injected;
// no Mongo, no network. Canary keys only.
import { describe, expect, it, vi } from 'vitest';
import { selectProvider } from '../agents/model-provider.js';
import { runE2e, type E2eDeps } from './cli.js';

describe('AT-27: e2e replay ignores the Gemini key', () => {
  it('AT-27: replay creates no Anthropic client, makes no fetch and keeps selectProvider on anthropic', async () => {
    const createAnthropicClient = vi.fn(() => ({ create: () => Promise.resolve({}) }));
    const fetchStub = vi.fn(() => {
      throw new Error('fetch must not be called');
    });
    vi.stubGlobal('fetch', fetchStub);
    let startEnv: Record<string, string | undefined> = {};
    let createdModel = false;
    const deps = {
      randomHex: () => 'abcdef012345',
      seed: () => Promise.resolve(0),
      dropDatabase: () => Promise.resolve(),
      createAnthropicClient,
      runServerProcess: (d: {
        env: Record<string, string | undefined>;
        createModel: () => unknown;
      }) => {
        startEnv = d.env;
        d.createModel();
        createdModel = true;
        return Promise.resolve(0);
      },
      baseStartDeps: {},
      connect: () => Promise.reject(new Error('connect must not be called')),
      buildApp: () => {
        throw new Error('buildApp must not be called');
      },
      stdout: () => undefined,
      stderr: () => undefined,
      recordingsDir: new URL('../../../e2e/recordings', import.meta.url).pathname,
    } as unknown as E2eDeps;

    try {
      const code = await runE2e(
        {
          MONGODB_URI: 'mongodb://localhost:27017/hr',
          ANTHROPIC_API_KEY: 'sk-CANARY-0002',
          GEMINI_API_KEY: 'gm-CANARY-0001',
        },
        deps,
      );
      expect(code).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(createdModel).toBe(true);
    expect(createAnthropicClient).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(selectProvider(startEnv)).toBe('anthropic');
  });
});
