// Spec gemini-fallback: AT-8 for runPolicyQa (rule 8): the request and qa_model_call.model carry the
// model actually called. Fake client, real QA policy file, synthetic handbook text; fetch throws.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../audit.js';
import { loadQaPolicy } from '../../policies/load.js';
import type { ModelClient } from '../schemas.js';
import { runPolicyQa } from './run.js';

const POLICY_PATH = join(import.meta.dirname, '..', '..', '..', '..', 'policies', 'qa', 'v1.yaml');

async function run(withResolve: boolean) {
  const models: unknown[] = [];
  const model: ModelClient = {
    create: (req) => {
      models.push(req.model);
      return Promise.resolve({
        content: [{ type: 'text', text: 'Claims are due within 30 days.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });
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
  const sink = new InMemoryAuditSink();
  let n = 0;
  await runPolicyQa(
    {
      requestId: 'req-1',
      actor: { employeeId: 'emp-004', role: 'employee' },
      question: 'What is the deadline for expense claims?',
    },
    {
      model,
      prompts: {
        load: () => Promise.resolve({ found: true as const, text: 'QA-PROMPT data only.' }),
      },
      audit: sink,
      clock: { nowMs: () => 0, nowIso: () => '2026-10-28T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      idGen: () => `evt-${String((n += 1))}`,
      detectInjection: () => ({ flagged: false }),
      handbookBody: '# Synthetic handbook\n\nExpense claims are due within 30 days.',
      handbookHash: 'a'.repeat(64),
      policy: loadQaPolicy(POLICY_PATH),
    },
  );
  const call = sink.events.map((e) => e.payload).find((p) => p.kind === 'qa_model_call');
  return { models, call };
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

describe('AT-8: runPolicyQa records the model actually called', () => {
  it('AT-8: with resolveModel the request and qa_model_call carry the Gemini id', async () => {
    const { models, call } = await run(true);
    expect(models).toEqual(['gemini-3.5-flash-lite']);
    expect(call?.model).toBe('gemini-3.5-flash-lite');
  });

  it('AT-8: without resolveModel the config id is recorded', async () => {
    const { models, call } = await run(false);
    expect(models).toEqual(['claude-sonnet-5-5']);
    expect(call?.model).toBe('claude-sonnet-5-5');
  });
});
