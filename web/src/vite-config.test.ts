// @vitest-environment node
// Spec e2e-demo, rule 11 (AT-24). The /api proxy target comes from API_PROXY_TARGET (node side only).
// Placed in web/src because the web project only includes src/**/*.test.{ts,tsx}.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ProxyShape {
  target: string;
  rewrite: (path: string) => string;
}

async function loadProxy(): Promise<ProxyShape> {
  vi.resetModules();
  const mod = (await import('../vite.config.js')) as {
    default: { server?: { proxy?: Record<string, ProxyShape> } };
  };
  const proxy = mod.default.server?.proxy?.['/api'];
  if (!proxy) throw new Error('no /api proxy');
  return proxy;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('vite.config.ts /api proxy', () => {
  it('AT-24: defaults to http://127.0.0.1:3000 when API_PROXY_TARGET is unset', async () => {
    vi.stubEnv('API_PROXY_TARGET', undefined);
    delete process.env.API_PROXY_TARGET;
    const proxy = await loadProxy();
    expect(proxy.target).toBe('http://127.0.0.1:3000');
    expect(proxy.rewrite('/api/chat')).toBe('/chat');
  });

  it('AT-24: uses API_PROXY_TARGET when set and keeps the /api rewrite', async () => {
    vi.stubEnv('API_PROXY_TARGET', 'http://127.0.0.1:3100');
    const proxy = await loadProxy();
    expect(proxy.target).toBe('http://127.0.0.1:3100');
    expect(proxy.rewrite('/api/chat')).toBe('/chat');
  });

  it('AT-24: the config reads no VITE_-prefixed variable for the target', () => {
    const text = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
    expect(text).toContain('API_PROXY_TARGET');
    expect(text).not.toMatch(/VITE_/);
  });
});
