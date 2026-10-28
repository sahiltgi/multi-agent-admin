// Spec web-shell, AT-13 (rule 7). Assumes env.ts exports `WebEnv` and
// `resolveApiBase(env: unknown): string` (the spec names only WebEnv; the resolver name is a guess).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import viteConfig from '../../vite.config.js';
import {
  getApprovals,
  getChecklist,
  getOnboardingList,
  patchTaskDone,
  postAction,
  postChat,
  postOnboarding,
} from './client.js';
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

// specs/onboarding-ui.md AT-2 (rule 2): request() gains an explicit method and four onboarding calls.
describe('onboarding-ui: client methods and the four onboarding calls', () => {
  const reply = (status: number, body: string, type = 'application/json'): Response =>
    new Response(body, { status, headers: { 'content-type': type } });
  const opts = { employeeId: 'emp-001', signal: new AbortController().signal };
  type Recorded = [string, RequestInit];
  const stub = (impl: () => Promise<Response>) => {
    const f = vi.fn(impl);
    vi.stubGlobal('fetch', f);
    return f;
  };
  const first = (f: ReturnType<typeof stub>): Recorded => f.mock.calls[0] as unknown as Recorded;
  const headerNames = (init: RequestInit): string[] =>
    Object.keys(init.headers as Record<string, string>).sort();
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AT-2: postChat and postAction still send POST and getApprovals still sends GET', async () => {
    const f = stub(() => Promise.resolve(reply(200, '{}')));
    await postChat({ message: 'hello there' }, opts);
    expect(first(f)[1].method).toBe('POST');
    const g = stub(() => Promise.resolve(reply(200, '{}')));
    await getApprovals(opts);
    expect(first(g)[1].method).toBe('GET');
    expect(headerNames(first(g)[1])).toEqual(['accept', 'x-demo-user']);
    const h = stub(() => Promise.resolve(reply(200, '{}')));
    await postAction(
      'ai-001',
      { action: 'approve', seen: { verdict: 'ROUTE_TO_MANAGER', policyHash: 'a'.repeat(64) } },
      opts,
    );
    expect(first(h)[1].method).toBe('POST');
  });

  it('AT-2: the four calls use the table URLs, methods and header names, with encoded segments', async () => {
    const f = stub(() => Promise.resolve(reply(200, '{}')));
    await getOnboardingList(null, opts);
    expect(first(f)[0]).toBe('/api/onboarding?limit=50');
    expect(first(f)[1].method).toBe('GET');
    expect(headerNames(first(f)[1])).toEqual(['accept', 'x-demo-user']);

    const g = stub(() => Promise.resolve(reply(200, '{}')));
    await getOnboardingList('c 1/x', opts);
    expect(first(g)[0]).toBe('/api/onboarding?limit=50&cursor=c%201%2Fx');

    const h = stub(() => Promise.resolve(reply(200, '{}')));
    await getChecklist('../approvals', opts);
    expect(first(h)[0]).toBe('/api/onboarding/..%2Fapprovals');
    expect(first(h)[1].method).toBe('GET');

    const p = stub(() => Promise.resolve(reply(200, '{}')));
    await postOnboarding(
      {
        newJoinerName: 'Demo Joiner Kestrel',
        templateId: 'engineer',
        startDate: '2026-11-30',
        newHireTeam: 'team-b',
        managerEmployeeId: 'emp-009',
        buddyEmployeeId: 'emp-010',
      },
      opts,
    );
    expect(first(p)[0]).toBe('/api/onboarding');
    expect(first(p)[1].method).toBe('POST');
    expect(headerNames(first(p)[1])).toEqual(['accept', 'content-type', 'x-demo-user']);

    const t = stub(() => Promise.resolve(reply(200, '{}')));
    await patchTaskDone('cl-001', 'a/b', opts);
    expect(first(t)[0]).toBe('/api/onboarding/cl-001/tasks/a%2Fb');
    expect(first(t)[1].method).toBe('PATCH');
    expect(headerNames(first(t)[1])).toEqual(['accept', 'content-type', 'x-demo-user']);
    expect(first(t)[1].body).toBe('{"status":"done"}');
  });

  it('AT-2: each call maps a bad 200, an HTML 502, a foreign 403 and a rejected fetch to fixed results, with one fetch', async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ['list', () => getOnboardingList(null, opts)],
      ['view', () => getChecklist('cl-001', opts)],
      [
        'create',
        () =>
          postOnboarding(
            {
              newJoinerName: 'Test Joiner A',
              templateId: 'sales',
              startDate: '2026-12-01',
              newHireTeam: 'team-a',
              managerEmployeeId: 'emp-002',
              buddyEmployeeId: null,
            },
            opts,
          ),
      ],
      ['tick', () => patchTaskDone('cl-001', 'laptop', opts)],
    ];
    for (const [name, call] of calls) {
      const bad = stub(() =>
        Promise.resolve(reply(200, JSON.stringify({ unexpected: 'leak-xyz' }))),
      );
      expect(await call(), name).toEqual({ ok: false, kind: 'invalid_response' });
      expect(bad).toHaveBeenCalledTimes(1);
      stub(() => Promise.resolve(reply(502, '<html>leak-502</html>', 'text/html')));
      expect(await call(), name).toEqual({ ok: false, kind: 'invalid_response' });
      stub(() => Promise.resolve(reply(403, JSON.stringify({ error: 'nope-raw' }))));
      expect(await call(), name).toEqual({ ok: false, kind: 'invalid_response' });
      const down = stub(() => Promise.reject(new TypeError('net-detail')));
      expect(await call(), name).toEqual({ ok: false, kind: 'network' });
      expect(down).toHaveBeenCalledTimes(1);
    }
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
