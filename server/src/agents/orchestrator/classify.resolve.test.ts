// Spec gemini-fallback: AT-8 for classifyMessage (rule 8): decision.model is the model actually called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../audit.js';
import { ToolRegistry } from '../registry.js';
import type { ModelClient } from '../schemas.js';
import { classifyMessage } from './classify.js';
import { createRouteTool } from './route-tool.js';

const USAGE = { input_tokens: 5, output_tokens: 2 };

function client(withResolve: boolean): { client: ModelClient; models: unknown[] } {
  let n = 0;
  const models: unknown[] = [];
  const script = [
    {
      content: [{ type: 'tool_use', id: 'tu-1', name: 'route', input: { label: 'leave' } }],
      stop_reason: 'tool_use',
      usage: USAGE,
    },
    { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: USAGE },
  ];
  return {
    models,
    client: {
      create: (req) => {
        models.push(req.model);
        const step = script[n];
        n += 1;
        return step ? Promise.resolve(step) : Promise.reject(new Error('exhausted'));
      },
      ...(withResolve
        ? {
            resolveModel: (id: string) =>
              id === 'claude-haiku-5-5' || id === 'claude-sonnet-5-5'
                ? 'gemini-3.5-flash-lite'
                : 'unmapped',
          }
        : {}),
    },
  };
}

async function classify(withResolve: boolean) {
  const { client: model, models } = client(withResolve);
  const registry = new ToolRegistry();
  registry.register(createRouteTool('Synthetic route description.'));
  const sink = new InMemoryAuditSink();
  let n = 0;
  const decision = await classifyMessage(
    {
      requestId: 'req-1',
      agentId: 'orchestrator',
      actor: { employeeId: 'emp-004', role: 'employee' },
      userText: 'I would like annual leave from 2026-11-16 to 2026-11-18',
      documents: [],
    },
    {
      model,
      registry,
      prompts: { load: () => Promise.resolve({ found: true as const, text: 'ORCH data only.' }) },
      audit: sink,
      clock: { nowMs: () => 0, nowIso: () => '2026-10-28T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      idGen: () => `evt-${String((n += 1))}`,
      detectInjection: () => ({ flagged: false }),
      messages: { load: () => Promise.resolve({ found: false as const }) },
    },
  );
  return { decision, models, events: sink.events.map((e) => e.payload) };
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

describe('AT-8: classifyMessage records the model actually called', () => {
  it('AT-8: with resolveModel the decision, requests and routing audit carry the Gemini id', async () => {
    const { decision, models, events } = await classify(true);
    expect(models.every((m) => m === 'gemini-3.5-flash-lite')).toBe(true);
    expect((decision as { model: string }).model).toBe('gemini-3.5-flash-lite');
    const routing = events.find((p) => p.kind === 'routing_decision');
    expect(routing?.model).toBe('gemini-3.5-flash-lite');
  });

  it('AT-8: without resolveModel the config id is recorded', async () => {
    const { decision } = await classify(false);
    expect((decision as { model: string }).model).toBe('claude-haiku-5-5');
  });
});
