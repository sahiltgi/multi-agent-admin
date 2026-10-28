// Spec gemini-fallback: AT-8 for the shared runtime (rule 8): the model id sent and recorded is
// actualModel(deps.model, config.model). Fake clients only; fetch throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryAuditSink } from './audit.js';
import { LEAVE_CONFIG } from './leave/config.js';
import { ToolRegistry } from './registry.js';
import { createRuntime, type PromptLoader } from './runtime.js';
import type { ModelClient } from './schemas.js';

type Rec = Record<string, unknown>;
const USAGE = { input_tokens: 5, output_tokens: 2 };

function fake(withResolve: boolean) {
  const requests: Rec[] = [];
  let n = 0;
  const script: Rec[] = [
    {
      content: [{ type: 'tool_use', id: 'tu-1', name: 'get_holidays', input: { year: 2026 } }],
      stop_reason: 'tool_use',
      usage: USAGE,
    },
    { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: USAGE },
  ];
  const client: ModelClient = {
    create: (req) => {
      requests.push(structuredClone(req));
      const step = script[n];
      n += 1;
      return step ? Promise.resolve(step) : Promise.reject(new Error('exhausted'));
    },
    ...(withResolve
      ? {
          resolveModel: (id: string) =>
            id === 'claude-sonnet-5-5' || id === 'claude-haiku-5-5'
              ? 'gemini-3.5-flash-lite'
              : 'unmapped',
        }
      : {}),
  };
  return { client, requests };
}

async function runWith(withResolve: boolean) {
  const { client, requests } = fake(withResolve);
  const registry = new ToolRegistry();
  registry.register({
    name: 'get_holidays',
    description: 'List public holidays for a year.',
    inputSchema: z.object({ year: z.number().int() }).strict(),
    outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
    handler: () => Promise.resolve({ holidays: [] }),
  });
  const sink = new InMemoryAuditSink();
  const prompts: PromptLoader = {
    load: () => Promise.resolve({ found: true as const, text: 'LEAVE-PROMPT data only.' }),
  };
  let n = 0;
  const runtime = createRuntime(
    { ...LEAVE_CONFIG, allowlist: ['get_holidays'] },
    {
      model: client,
      registry,
      prompts,
      audit: sink,
      clock: { nowMs: () => 0, nowIso: () => '2026-10-28T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      idGen: () => `evt-${String((n += 1))}`,
      detectInjection: () => ({ flagged: false }),
    },
  );
  const result = await runtime.run({
    requestId: 'req-1',
    agentId: 'leave',
    actor: { employeeId: 'emp-004', role: 'employee' },
    userText: 'Annual leave 2026-11-16 to 2026-11-17',
    documents: [],
  });
  return { result, requests, payloads: sink.events.map((e) => e.payload as Rec) };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fetch must not be called');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AT-8: runtime records the model actually called', () => {
  it('AT-8: with resolveModel every request, audit payload and RunResult carry the Gemini id', async () => {
    const { result, requests, payloads } = await runWith(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.model).toBe('gemini-3.5-flash-lite');
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) expect(p.model).toBe('gemini-3.5-flash-lite');
    expect(result.model).toBe('gemini-3.5-flash-lite');
  });

  it('AT-8: without resolveModel the config id is recorded', async () => {
    const { result, requests, payloads } = await runWith(false);
    for (const r of requests) expect(r.model).toBe('claude-sonnet-5-5');
    for (const p of payloads) expect(p.model).toBe('claude-sonnet-5-5');
    expect(result.model).toBe('claude-sonnet-5-5');
  });
});
