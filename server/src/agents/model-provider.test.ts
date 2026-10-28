// Spec gemini-fallback: AT-1, AT-2 (client and static parts), AT-5, AT-23 (static), AT-24, AT-26 (static).
// Synthetic data only. The keys below are canaries that must never appear in a message.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Pricing } from '../lib/cost.js';
import { SHIPPED_AGENT_CONFIGS, unpricedModels } from '../server/boot.js';
import {
  GEMINI_MODEL_MAP,
  NO_MODEL_KEY_MESSAGE,
  UnmappedModelError,
  actualModel,
  createModelClient,
  resolveModelId,
  selectProvider,
} from './model-provider.js';

const GM = 'gm-CANARY-0001';
const SK = 'sk-CANARY-0002';
const SRC = join(import.meta.dirname, '..');
const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8');

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error('fetch must not be called in tests');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AT-1: selectProvider', () => {
  it('AT-1: a present Anthropic key wins, with or without a Gemini key', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: SK, GEMINI_API_KEY: GM })).toBe('anthropic');
    expect(selectProvider({ ANTHROPIC_API_KEY: SK })).toBe('anthropic');
  });

  it('AT-1: an empty or absent Anthropic key with a Gemini key gives gemini', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: '', GEMINI_API_KEY: GM })).toBe('gemini');
    expect(selectProvider({ GEMINI_API_KEY: GM })).toBe('gemini');
  });

  it('AT-1: no key throws NO_MODEL_KEY_MESSAGE naming both variables and no value', () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' }]) {
      let caught: unknown;
      try {
        selectProvider(env);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(msg).toBe(NO_MODEL_KEY_MESSAGE);
      expect(msg).toContain('ANTHROPIC_API_KEY');
      expect(msg).toContain('GEMINI_API_KEY');
      expect(msg).not.toContain(GM);
      expect(msg).not.toContain(SK);
    }
  });

  it('AT-1: a whitespace-only key is used verbatim, not trimmed', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: ' ' })).toBe('anthropic');
  });
});

describe('AT-2: createModelClient', () => {
  it('AT-2: with only the Gemini key the client has resolveModel and no fetch happens while building', () => {
    const client = createModelClient({ ANTHROPIC_API_KEY: '', GEMINI_API_KEY: GM });
    expect(typeof client.resolveModel).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AT-2: with the Anthropic key the client has no resolveModel', () => {
    const client = createModelClient({ ANTHROPIC_API_KEY: SK, GEMINI_API_KEY: GM });
    expect(client.resolveModel).toBeUndefined();
  });

  it('AT-2: index.ts and evals/cli.ts import createModelClient and not createAnthropicClient', () => {
    for (const file of [['index.ts'], ['evals', 'cli.ts']]) {
      const text = read(...file);
      expect(text, file.join('/')).toMatch(/createModelClient/);
      expect(text, file.join('/')).not.toMatch(/createAnthropicClient/);
    }
  });
});

describe('AT-5: model ids', () => {
  it('AT-5: both shipped Claude ids map to gemini-3.5-flash-lite on gemini', () => {
    expect(resolveModelId('gemini', 'claude-sonnet-5-5')).toBe('gemini-3.5-flash-lite');
    expect(resolveModelId('gemini', 'claude-haiku-5-5')).toBe('gemini-3.5-flash-lite');
    expect(GEMINI_MODEL_MAP['claude-haiku-5-5']).toBe('gemini-3.5-flash-lite');
  });

  it('AT-5: anthropic resolution is the identity', () => {
    expect(resolveModelId('anthropic', 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
  });

  it('AT-5: an unmapped, __proto__ or toString id throws UnmappedModelError naming the id', () => {
    for (const id of ['claude-opus-x', '__proto__', 'toString']) {
      expect(() => resolveModelId('gemini', id), id).toThrow(UnmappedModelError);
      expect(() => resolveModelId('gemini', id), id).toThrow(id);
    }
  });

  it('AT-8: actualModel is the identity without resolveModel and resolves with it', () => {
    expect(actualModel({ create: () => Promise.resolve({}) }, 'claude-haiku-5-5')).toBe(
      'claude-haiku-5-5',
    );
    expect(
      actualModel(
        { create: () => Promise.resolve({}), resolveModel: (id) => `x-${id}` },
        'claude-haiku-5-5',
      ),
    ).toBe('x-claude-haiku-5-5');
  });
});

describe('AT-24: evals/pricing.yaml', () => {
  const pricing = Pricing.parse(
    parseYaml(readFileSync(join(REPO, 'evals', 'pricing.yaml'), 'utf8')),
  );

  it('AT-24: has a zero-cost gemini-3.5-flash-lite entry', () => {
    expect(pricing.models['gemini-3.5-flash-lite']).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('AT-24: unpricedModels is empty for both providers resolved shipped configs', () => {
    for (const provider of ['anthropic', 'gemini'] as const) {
      const resolved = SHIPPED_AGENT_CONFIGS.map((c) => ({
        ...c,
        model: resolveModelId(provider, c.model),
      }));
      expect(unpricedModels(pricing, resolved), provider).toEqual([]);
    }
  });
});

describe('AT-23 and AT-26: static checks', () => {
  it('AT-23: gemini-client.ts and model-provider.ts contain no console.', () => {
    for (const f of ['gemini-client.ts', 'model-provider.ts']) {
      expect(read('agents', f), f).not.toMatch(/console\./);
    }
  });

  it('AT-26: gemini-client.ts and model-provider.ts import nothing from the gate', () => {
    for (const f of ['gemini-client.ts', 'model-provider.ts']) {
      expect(read('agents', f), f).not.toMatch(/from\s+['"][^'"]*\/gate\//);
    }
  });

  it('AT-26: only anthropic-client.ts imports @anthropic-ai/sdk', () => {
    for (const f of ['gemini-client.ts', 'model-provider.ts']) {
      // Import specifiers only: the pinned Gemini URL itself contains '/v1beta/openai/' (D-3).
      expect(read('agents', f), f).not.toMatch(
        /from\s+['"](?:@anthropic-ai\/sdk|@google[^'"]*|openai[^'"]*)['"]/,
      );
    }
  });
});
