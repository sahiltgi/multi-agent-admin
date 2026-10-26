// specs/agent-metrics.md AT-1, AT-2 (rules 1, 2): the pure pricing module moved to lib/cost.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as evalsCost from '../evals/cost.js';
import * as cost from './cost.js';
import { Pricing, priceEvents, TokenCount, Usage } from './cost.js';

type Rec = Record<string, unknown>;

export const TEST_PRICING = Pricing.parse({
  version: 1,
  asOf: '2026-10-01',
  currency: 'USD',
  models: {
    'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 },
    'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15 },
  },
});

const modelCall = (model: string, tokens: { input: number; output: number } | null): Rec => ({
  eventType: 'agent_step',
  payload: { kind: 'model_call', model, tokens },
});
const qaCall = (model: string, tokens: { input: number; output: number } | null): Rec => ({
  eventType: 'agent_step',
  payload: { kind: 'qa_model_call', model, tokens },
});

describe('agent-metrics AT-1: lib/cost.ts is a pure module', () => {
  it('AT-1: exports Pricing, TokenCount, Usage and priceEvents; no priceCase anywhere', () => {
    expect(typeof cost.priceEvents).toBe('function');
    expect(cost.Pricing).toBeDefined();
    expect(cost.TokenCount).toBeDefined();
    expect(cost.Usage).toBeDefined();
    expect('priceCase' in cost).toBe(false);
    expect('priceCase' in evalsCost).toBe(false);
    expect(typeof evalsCost.agentConfig).toBe('function');
    expect(typeof evalsCost.requiredModels).toBe('function');
  });

  it('AT-1: its only import is zod', () => {
    const src = readFileSync(join(import.meta.dirname, 'cost.ts'), 'utf8');
    const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s).toBe('zod');
  });

  it('AT-1: Usage is strict and holds tokens and a non-negative costUsd', () => {
    expect(Usage.safeParse({ tokens: { input: 1, output: 2 }, costUsd: 0.1 }).success).toBe(true);
    expect(Usage.safeParse({ tokens: { input: 1, output: 2 }, costUsd: -1 }).success).toBe(false);
    expect(Usage.safeParse({ tokens: { input: 1, output: 2 }, costUsd: 0, extra: 1 }).success).toBe(
      false,
    );
    expect(TokenCount.safeParse({ input: 1.5, output: 0 }).success).toBe(false);
  });
});

describe('agent-metrics AT-2: priceEvents', () => {
  it('AT-2: model_call (haiku 100/10) plus qa_model_call (sonnet 200/20) is 300/30 and 0.00105', () => {
    const r = priceEvents(
      [
        modelCall('claude-haiku-5-5', { input: 100, output: 10 }),
        qaCall('claude-sonnet-5-5', { input: 200, output: 20 }),
      ],
      TEST_PRICING,
    );
    expect(r.tokens).toEqual({ input: 300, output: 30 });
    expect(Math.abs(r.costUsd - (100 * 1 + 10 * 5 + 200 * 3 + 20 * 15) / 1e6)).toBeLessThan(1e-12);
    expect(Math.abs(r.costUsd - 0.00105)).toBeLessThan(1e-12);
  });

  it('AT-2: an event with tokens null adds 0', () => {
    const r = priceEvents(
      [
        modelCall('claude-sonnet-5-5', null),
        modelCall('claude-haiku-5-5', { input: 4, output: 1 }),
      ],
      TEST_PRICING,
    );
    expect(r.tokens).toEqual({ input: 4, output: 1 });
  });

  it('AT-2: an intake_outcome event carrying usage adds 0', () => {
    const summary: Rec = {
      eventType: 'agent_step',
      payload: {
        kind: 'intake_outcome',
        requestId: 'req-1',
        usage: { tokens: { input: 999, output: 99 }, costUsd: 9 },
      },
    };
    expect(priceEvents([summary], TEST_PRICING)).toEqual({
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    });
  });

  it('AT-2: an event for an unpriced model (model-x) throws, never 0', () => {
    expect(() =>
      priceEvents([modelCall('model-x', { input: 1, output: 1 })], TEST_PRICING),
    ).toThrow();
  });

  it('AT-2: no events give 0/0 and cost 0', () => {
    expect(priceEvents([], TEST_PRICING)).toEqual({ tokens: { input: 0, output: 0 }, costUsd: 0 });
  });
});
