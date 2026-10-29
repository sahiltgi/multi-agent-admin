// Spec gemini-fallback: AT-21 (real runtime over the real Gemini client), AT-22 (watchModel
// classification) and the AT-23 canary check. Fake clock, stubbed fetch and sleep. Canary key only.
// (Named .flow.test.ts because vitest.config.ts excludes *.integration.test.ts from the server project.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { watchModel } from '../evals/model.js';
import { InMemoryAuditSink } from './audit.js';
import { createGeminiClient } from './gemini-client.js';
import { LEAVE_CONFIG } from './leave/config.js';
import { ToolRegistry } from './registry.js';
import { createRuntime, type PromptLoader } from './runtime.js';
import type { ModelRequest } from './schemas.js';

const KEY = 'gm-CANARY-0001';
const MODEL = 'gemini-3.5-flash-lite';

type Rec = Record<string, unknown>;
const completion = (
  message: Rec,
  finish: string,
  usage = { prompt_tokens: 7, completion_tokens: 3 },
) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }],
      usage,
    }),
    { status: 200 },
  );
const callOf = (id: string, name: string, args: unknown): Rec => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function build(script: Response[], configModel: string = LEAVE_CONFIG.model) {
  const state = { now: 0 };
  const starts: number[] = [];
  const bodies: Rec[] = [];
  const fetchStub = vi.fn((_url: unknown, init?: RequestInit) => {
    starts.push(state.now);
    bodies.push(JSON.parse(init?.body as string) as Rec);
    const next = script.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('script exhausted'));
  });
  const sleep = vi.fn((ms: number) => {
    state.now += ms;
    return Promise.resolve();
  });
  const model = createGeminiClient(
    { GEMINI_API_KEY: KEY },
    { fetch: fetchStub as unknown as typeof fetch, nowMs: () => state.now, sleep },
  );

  const registry = new ToolRegistry();
  const handler = vi.fn(() => Promise.resolve({ holidays: ['2026-12-25'] }));
  registry.register({
    name: 'get_holidays',
    description: 'List public holidays for a year.',
    inputSchema: z.object({ year: z.number().int() }).strict(),
    outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
    handler: handler,
  });
  const sink = new InMemoryAuditSink();
  const prompts: PromptLoader = {
    load: () => Promise.resolve({ found: true as const, text: 'LEAVE-PROMPT-V1 data only.' }),
  };
  let n = 0;
  const runtime = createRuntime(
    { ...LEAVE_CONFIG, model: configModel, allowlist: ['get_holidays'] },
    {
      model,
      registry,
      prompts,
      audit: sink,
      clock: { nowMs: () => 0, nowIso: () => '2026-10-28T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      idGen: () => `evt-${String((n += 1))}`,
      detectInjection: () => ({ flagged: false }),
    },
  );
  return { runtime, sink, starts, bodies, fetchStub, handler, sleep };
}

const INPUT = {
  requestId: 'req-1',
  agentId: 'leave',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'Annual leave 2026-11-16 to 2026-11-17',
  documents: [],
};

let logSpies: { mock: { calls: unknown[] } }[];
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('global fetch must not be called');
    }),
  );
  logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AT-21: runtime over the Gemini client', () => {
  it('AT-21: a tool loop completes, ids round-trip, model_call records the Gemini model, requests are 4 s apart', async () => {
    const h = build([
      completion(
        { content: null, tool_calls: [callOf('call-1', 'get_holidays', { year: 2026 })] },
        'tool_calls',
      ),
      completion({ content: 'Done.' }, 'stop'),
    ]);
    const result = await h.runtime.run(INPUT);
    expect(result.outcome).toBe('completed');
    expect(h.fetchStub).toHaveBeenCalledTimes(2);

    const second = h.bodies[1]?.messages as Rec[];
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call-1');
    expect(h.bodies[1]?.model).toBe(MODEL);

    const payloads = h.sink.events.map((e) => e.payload as Rec);
    const modelCalls = payloads.filter((p) => p.kind === 'model_call');
    expect(modelCalls.length).toBe(2);
    for (const p of modelCalls) expect(p.model).toBe(MODEL);
    for (const p of modelCalls) expect(p.tokens).toEqual({ input: 7, output: 3 });
    expect((result as { model: string }).model).toBe(MODEL);

    expect((h.starts[1] ?? 0) - (h.starts[0] ?? 0)).toBeGreaterThanOrEqual(4000);
  });

  it('AT-21: a fabricated approve_leave call ends tool_violation and nothing is approved', async () => {
    const h = build([
      completion(
        { content: null, tool_calls: [callOf('call-9', 'approve_leave', {})] },
        'tool_calls',
      ),
    ]);
    const result = await h.runtime.run(INPUT);
    expect(result.outcome).toBe('tool_violation');
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.fetchStub).toHaveBeenCalledTimes(1);
  });

  it('AT-8: an unmapped config model fails closed with an audit trail and no fetch', async () => {
    const h = build([completion({ content: 'Done.' }, 'stop')], 'claude-unknown');
    const result = await h.runtime.run(INPUT);
    expect(result.outcome).toBe('error');
    expect((result as { code?: string }).code).toBe('model_error');
    expect(h.fetchStub).not.toHaveBeenCalled();
    expect(h.sleep).not.toHaveBeenCalled();
    const kinds = h.sink.events.map((e) => (e.payload as Rec).kind);
    expect(kinds).toContain('model_call');
    expect(kinds.at(-1)).toBe('run_end');
  });

  it('AT-23: the canary key appears in no console call, audit event or run result', async () => {
    const h = build([completion({ content: 'Done.' }, 'stop')]);
    const result = await h.runtime.run(INPUT);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(h.sink.events)).not.toContain(KEY);
    for (const spy of logSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });
});

describe('AT-22: watchModel over the Gemini client', () => {
  const failureFor = async (status: number): Promise<string | null> => {
    const fetchStub = vi.fn(() => Promise.resolve(new Response('{}', { status })));
    const inner = createGeminiClient(
      { GEMINI_API_KEY: KEY },
      {
        fetch: fetchStub as unknown as typeof fetch,
        nowMs: () => 0,
        sleep: () => Promise.resolve(),
      },
    );
    const watched = watchModel(inner);
    const req = {
      model: MODEL,
      system: 'S',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      max_tokens: 10,
      output_config: { effort: 'low' },
    } as ModelRequest;
    await watched.client
      .create(req, { signal: new AbortController().signal, timeout: 5000 })
      .catch(() => undefined);
    return watched.failure();
  };

  it('AT-22: a 429 is model_unavailable', async () => {
    expect(await failureFor(429)).toBe('model_unavailable');
  });

  it('AT-22: a 400 is run_failed', async () => {
    expect(await failureFor(400)).toBe('run_failed');
  });
});
