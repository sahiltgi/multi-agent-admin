// Spec web-shell, AT-13 (rule 7). Assumes env.ts exports `WebEnv` and
// `resolveApiBase(env: unknown): string` (the spec names only WebEnv; the resolver name is a guess).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config.js';
import { WebEnv, resolveApiBase } from './env.js';

const WEB_SRC = resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('api base url and dev proxy', () => {
  it('AT-13: a missing or empty VITE_API_BASE gives /api and one trailing slash is stripped', () => {
    expect(resolveApiBase(WebEnv.parse({})) + '/approvals').toBe('/api/approvals');
    expect(resolveApiBase(WebEnv.parse({ VITE_API_BASE: '' })) + '/approvals').toBe(
      '/api/approvals',
    );
    expect(
      resolveApiBase(WebEnv.parse({ VITE_API_BASE: 'http://127.0.0.1:3000/' })) + '/approvals',
    ).toBe('http://127.0.0.1:3000/approvals');
  });

  it('AT-13: the Vite dev proxy sends /api to the server and strips the prefix', () => {
    const server: unknown = (viteConfig as { server?: unknown }).server;
    const proxy = (server as { proxy?: Record<string, unknown> } | undefined)?.proxy;
    const api = proxy?.['/api'] as
      { target?: string; rewrite?: (path: string) => string } | undefined;
    expect(api?.target).toBe('http://127.0.0.1:3000');
    expect(api?.rewrite?.('/api/approvals')).toBe('/approvals');
  });

  it('AT-13: VITE_API_BASE is the only import.meta.env name read in non-test web code', () => {
    expect(existsSync(join(WEB_SRC, 'api', 'env.ts'))).toBe(true);
    const names = new Set<string>();
    for (const file of sourceFiles(WEB_SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/import\.meta\.env\.(\w+)/g)) {
        names.add(m[1] ?? '');
      }
    }
    expect([...names]).toEqual(['VITE_API_BASE']);
  });
});
