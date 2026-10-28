// Spec gemini-fallback: AT-9 (watchModel and the lazy production model forward resolveModel) and the
// evals/cli.ts half of AT-2 (inner client built at most once). Needs `productionDeps` exported from
// ./cli.js. Both client factories are mocked, so no SDK and no network are used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelClient, ModelRequest } from '../agents/schemas.js';
import { watchModel } from './model.js';

const built = { gemini: 0, anthropic: 0 };
vi.mock('../agents/gemini-client.js', () => ({
  createGeminiClient: vi.fn(() => {
    built.gemini += 1;
    return { create: () => Promise.resolve({ ok: true }) };
  }),
}));
vi.mock('../agents/anthropic-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/anthropic-client.js')>();
  return {
    ...actual,
    createAnthropicClient: vi.fn(() => {
      built.anthropic += 1;
      return { create: () => Promise.resolve({ ok: true }) };
    }),
  };
});

const REQ = {
  model: 'claude-sonnet-5-5',
  system: 'S',
  messages: [],
  max_tokens: 10,
  output_config: { effort: 'low' },
} as unknown as ModelRequest;
const OPTS = { signal: new AbortController().signal, timeout: 1000 };

beforeEach(() => {
  built.gemini = 0;
  built.anthropic = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fetch must not be called');
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AT-9: resolveModel is forwarded by wrappers', () => {
  it('AT-9: watchModel forwards the inner resolveModel', () => {
    const inner: ModelClient = {
      create: () => Promise.resolve({}),
      resolveModel: (id: string) => `resolved-${id}`,
    };
    const watched = watchModel(inner).client;
    expect(watched.resolveModel?.('claude-haiku-5-5')).toBe('resolved-claude-haiku-5-5');
  });

  it('AT-9: watchModel over a client without resolveModel has none', () => {
    const watched = watchModel({ create: () => Promise.resolve({}) }).client;
    expect(watched.resolveModel).toBeUndefined();
  });

  it('AT-9: the production model resolves ids from process.env before building the inner client', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'gm-CANARY-0001');
    const { productionDeps } = await import('./cli.js');
    const deps = productionDeps();
    expect(deps.model.resolveModel?.('claude-sonnet-5-5')).toBe('gemini-3.5-flash-lite');
    expect(built.gemini).toBe(0);
    expect(built.anthropic).toBe(0);
  });
});

describe('AT-2: the lazy production model builds its inner client once', () => {
  it('AT-2: two create calls build one Gemini client', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'gm-CANARY-0001');
    const { productionDeps } = await import('./cli.js');
    const deps = productionDeps();
    await deps.model.create(REQ, OPTS);
    await deps.model.create(REQ, OPTS);
    expect(built.gemini).toBe(1);
    expect(built.anthropic).toBe(0);
  });

  it('AT-2: with an Anthropic key the production model has no resolveModel and builds the Anthropic client once', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-CANARY-0002');
    const { productionDeps } = await import('./cli.js');
    const deps = productionDeps();
    expect(deps.model.resolveModel?.('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    await deps.model.create(REQ, OPTS);
    await deps.model.create(REQ, OPTS);
    expect(built.anthropic).toBe(1);
  });
});
