// specs/agent-metrics.md rule 6 (requestUsage), the helper behind AT-6 to AT-12.
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../domain/schemas.js';
import type { AuditReader } from '../http/approvals/ports.js';
import { Pricing } from '../lib/cost.js';
import { requestUsage } from './usage.js';

const TEST_PRICING = Pricing.parse({
  version: 1,
  asOf: '2026-10-01',
  currency: 'USD',
  models: {
    'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 },
    'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15 },
  },
});

let n = 0;
const call = (
  traceId: string,
  model: string,
  input: number,
  output: number,
  kind = 'model_call',
): AuditEvent =>
  ({
    id: `evt-${String(++n)}`,
    traceId,
    at: '2026-10-25T12:00:00.000Z',
    actor: { kind: 'agent', id: 'leave' },
    eventType: 'agent_step',
    payload: { kind, requestId: traceId, model, tokens: { input, output } },
  }) as unknown as AuditEvent;

function readerOf(byTrace: Record<string, AuditEvent[]>) {
  const listByTrace = vi.fn((id: string) => Promise.resolve(byTrace[id] ?? []));
  return { reader: { listByTrace } as unknown as AuditReader, listByTrace };
}

describe('agent-metrics rule 6: requestUsage', () => {
  it('AT-6: sums the trace model calls priced per model (600/60 is 0.0024)', async () => {
    const { reader } = readerOf({
      'req-1': [
        call('req-1', 'claude-haiku-5-5', 100, 10),
        call('req-1', 'claude-sonnet-5-5', 200, 20),
        call('req-1', 'claude-sonnet-5-5', 300, 30),
      ],
    });
    const u = await requestUsage(reader, TEST_PRICING, ['req-1']);
    expect(u?.tokens).toEqual({ input: 600, output: 60 });
    expect(Math.abs((u?.costUsd ?? 1) - 0.0024)).toBeLessThan(1e-12);
  });

  it('AT-6: a trace with no model calls is priced at 0/0 and $0, not null', async () => {
    const { reader } = readerOf({});
    expect(await requestUsage(reader, TEST_PRICING, ['req-1'])).toEqual({
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    });
  });

  it('AT-10: reads each id once, dedupes in order, and sums both traces (700/70 is 0.00285)', async () => {
    const { reader, listByTrace } = readerOf({
      R1: [call('R1', 'claude-sonnet-5-5', 400, 40)],
      R2: [
        call('R2', 'claude-haiku-5-5', 100, 10),
        call('R2', 'claude-sonnet-5-5', 200, 20, 'qa_model_call'),
      ],
    });
    const u = await requestUsage(reader, TEST_PRICING, ['R1', 'R2', 'R1']);
    expect(listByTrace.mock.calls.map((c) => c[0])).toEqual(['R1', 'R2']);
    expect(u?.tokens).toEqual({ input: 700, output: 70 });
    expect(Math.abs((u?.costUsd ?? 1) - 0.00285)).toBeLessThan(1e-12);
  });

  it('AT-12: any read rejection gives null, never a partial sum', async () => {
    const listByTrace = vi.fn((id: string) =>
      id === 'R2'
        ? Promise.reject(new Error('mongo-down'))
        : Promise.resolve([call(id, 'claude-haiku-5-5', 1, 1)]),
    );
    const reader = { listByTrace } as unknown as AuditReader;
    expect(await requestUsage(reader, TEST_PRICING, ['R1', 'R2'])).toBeNull();
  });

  it('AT-12: a model call for an unpriced model (model-x) gives null', async () => {
    const { reader } = readerOf({ 'req-1': [call('req-1', 'model-x', 5, 5)] });
    expect(await requestUsage(reader, TEST_PRICING, ['req-1'])).toBeNull();
  });
});
