// Spec web-shell, AT-13 (rule 7). Assumes env.ts exports `WebEnv` and
// `resolveApiBase(env: unknown): string` (the spec names only WebEnv; the resolver name is a guess).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import viteConfig from '../../vite.config.js';
import { postAction } from './client.js';
import { WebEnv, resolveApiBase } from './env.js';

describe('approval-queue-ui: postAction', () => {
  const H = '0123456789abcdef'.repeat(4);
  const BODY = { action: 'approve', seen: { verdict: 'ROUTE_TO_MANAGER', policyHash: H } } as const;
  const OK = {
    item: {
      id: 'ai-001',
      kind: 'leave_request',
      subjectId: 'lr-101',
      assigneeRole: 'manager',
      flagged: false,
      status: 'approved',
      createdAt: '2026-10-20T09:00:00Z',
    },
    auditEventId: 'ae-001',
  };
  const reply = (status: number, body: string, type = 'application/json'): Response =>
    new Response(body, { status, headers: { 'content-type': type } });
  const run = async (fetchImpl: () => Promise<Response>, signal = new AbortController().signal) => {
    const f = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', f);
    const result = await postAction('ai-001', BODY, { employeeId: 'emp-002', signal });
    return { result, f };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AT-14: a valid 200 gives the parsed ActionResponse', async () => {
    const { result, f } = await run(() => Promise.resolve(reply(200, JSON.stringify(OK))));
    expect(result).toEqual({ ok: true, data: OK });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/approvals/ai-001/actions');
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      'accept',
      'content-type',
      'x-demo-user',
    ]);
  });

  it('AT-14: an extra key, a 502 HTML page, an ErrorBody 409, a rejected fetch and an abort map to results', async () => {
    const extra = await run(() =>
      Promise.resolve(reply(200, JSON.stringify({ ...OK, extra: 'leak-xyz' }))),
    );
    expect(extra.result).toEqual({ ok: false, kind: 'invalid_response' });
    expect(extra.f).toHaveBeenCalledTimes(1);

    const html = await run(() =>
      Promise.resolve(reply(502, '<html>Bad Gateway</html>', 'text/html')),
    );
    expect(html.result).toEqual({ ok: false, kind: 'invalid_response' });

    const conflict = await run(() =>
      Promise.resolve(
        reply(
          409,
          JSON.stringify({
            error: {
              code: 'gate_result_changed',
              message: 'The gate result has changed since you saw it.',
            },
          }),
        ),
      ),
    );
    expect(conflict.result).toMatchObject({
      ok: false,
      kind: 'http',
      status: 409,
      error: { code: 'gate_result_changed' },
    });

    const down = await run(() => Promise.reject(new TypeError('boom-secret')));
    expect(down.result).toEqual({ ok: false, kind: 'network' });
    expect(down.f).toHaveBeenCalledTimes(1);

    const ac = new AbortController();
    ac.abort();
    const aborted = await run(
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ac.signal,
    );
    expect(aborted.result).toEqual({ ok: false, kind: 'aborted' });
  });
});

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
