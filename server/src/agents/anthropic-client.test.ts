import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from './anthropic-client.js';

const CANARY = 'TEST-KEY-CANARY-0000';

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error('non-Error thrown', { cause: e });
  }
  throw new Error('expected function to throw');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('anthropic-client adapter', () => {
  it('AT-5: an env without ANTHROPIC_API_KEY makes the adapter throw naming the variable', () => {
    const err = errorOf(() => createAnthropicClient({}));
    expect(err.message).toContain('ANTHROPIC_API_KEY');
  });

  it('AT-5: an empty ANTHROPIC_API_KEY makes the adapter throw naming the variable', () => {
    const err = errorOf(() => createAnthropicClient({ ANTHROPIC_API_KEY: '' }));
    expect(err.message).toContain('ANTHROPIC_API_KEY');
  });

  it('AT-5: a valid key builds a client with a create method', () => {
    const client = createAnthropicClient({ ANTHROPIC_API_KEY: CANARY });
    expect(typeof client.create).toBe('function');
  });

  it('AT-5: the error for an invalid env never contains a key value', () => {
    const err = errorOf(() => createAnthropicClient({ ANTHROPIC_API_KEY: { nested: CANARY } }));
    expect(err.message).toContain('ANTHROPIC_API_KEY');
    expect(err.message).not.toContain(CANARY);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(CANARY);
  });

  it('AT-6: exactly one source file imports @anthropic-ai/sdk and it is not runtime.ts', () => {
    const srcRoot = resolve(import.meta.dirname, '..');
    const importPattern =
      /^\s*(?:import|export)[^;]*from\s+['"]@anthropic-ai\/sdk|import\(\s*['"]@anthropic-ai\/sdk|require\(\s*['"]@anthropic-ai\/sdk/m;
    const matches = listTsFiles(srcRoot)
      .filter((file) => importPattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcRoot, file).split('\\').join('/'));
    expect(matches).toEqual(['agents/anthropic-client.ts']);
    expect(matches).not.toContain('agents/runtime.ts');
  });
});
