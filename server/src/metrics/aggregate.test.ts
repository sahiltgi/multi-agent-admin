// specs/agent-metrics.md AT-20 to AT-27 (rules 16 to 23): aggregate is pure over summary events.
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../domain/schemas.js';
import { aggregate } from './aggregate.js';
import { AgentMetricsResponse } from './schemas.js';

type Rec = Record<string, unknown>;
const WINDOW = { from: '2026-09-25T12:00:00.000Z', to: '2026-10-25T12:00:00.000Z' };
const AT = '2026-10-20T10:00:00.000Z';

let seq = 0;
function ev(payload: Rec, over: { id?: string; at?: string } = {}): AuditEvent {
  const requestId = String(payload.requestId);
  return {
    id: over.id ?? `evt-${String(++seq)}`,
    traceId: requestId,
    at: over.at ?? AT,
    actor: { kind: 'system', id: payload.kind === 'chat_turn' ? 'chat' : 'intake' },
    eventType: 'agent_step',
    payload,
  } as unknown as AuditEvent;
}
const usage = (costUsd: number, input: number, output: number) => ({
  tokens: { input, output },
  costUsd,
});
const intake = (requestId: string, over: Rec = {}, o = {}): AuditEvent =>
  ev(
    {
      kind: 'intake_outcome',
      requestId,
      actorRole: 'employee',
      label: 'leave',
      outcome: 'leave_submitted',
      escalation: null,
      verdict: null,
      qaVerdict: null,
      onboardingVerdict: null,
      usage: usage(0, 0, 0),
      ...over,
    },
    o,
  );
const chat = (requestId: string, over: Rec = {}, o = {}): AuditEvent =>
  ev(
    {
      kind: 'chat_turn',
      requestId,
      mode: 'classify',
      label: 'leave',
      outcome: 'reply',
      escalation: null,
      verdict: null,
      qaVerdict: null,
      onboardingVerdict: null,
      usage: usage(0, 0, 0),
      ...over,
    },
    o,
  );

const AT20: AuditEvent[] = [
  intake('req-1', { verdict: 'ROUTE_TO_MANAGER', usage: usage(0.002, 500, 50) }),
  intake('req-2', { verdict: 'ESCALATE_TO_HR', usage: usage(0.003, 600, 60) }),
  intake('req-3', {
    label: 'policy_qa',
    outcome: 'policy_escalated',
    qaVerdict: 'ESCALATE_TO_HR',
    usage: null,
  }),
  (() => {
    const e = chat('req-4', { label: 'policy_qa', outcome: 'answered', qaVerdict: 'AUTO_ANSWER' });
    delete (e.payload as Rec).usage; // legacy event: no usage key
    return e;
  })(),
  chat('req-5', { label: null, outcome: 'escalated', usage: usage(0.001, 200, 20) }),
  chat('req-6', {
    label: null,
    outcome: 'conflict',
    escalation: 'conversation_full',
    usage: usage(0.004, 300, 30),
  }),
  chat('req-7', { label: null, outcome: 'internal_error', usage: usage(0, 0, 0) }),
  ev({
    kind: 'onboarding_created',
    requestId: 'req-8',
    assigneeId: 'emp-002',
    checklistId: 'chk-001',
    verdict: 'MANAGER',
    usage: usage(0.0005, 100, 10),
  }),
  ev({
    kind: 'onboarding_create_escalated',
    requestId: 'req-9',
    reason: 'needs_details',
    usage: usage(0.0005, 100, 10),
  }),
  intake(
    'req-1',
    { outcome: 'escalated', usage: usage(0.009, 1, 1) },
    { at: '2026-10-21T10:00:00.000Z' },
  ),
];

describe('agent-metrics aggregate', () => {
  it('AT-20: counts, routes, verdicts, escalation and cost over the mixed events', () => {
    const r = aggregate(AT20, WINDOW);
    expect(AgentMetricsResponse.safeParse(r).success).toBe(true);
    expect(r.from).toBe(WINDOW.from);
    expect(r.to).toBe(WINDOW.to);
    expect(r.requests).toBe(8);
    expect(r.byRoute).toEqual({
      leave: 2,
      policy_qa: 2,
      onboarding: 2,
      prohibited: 0,
      out_of_scope: 0,
      unclear: 0,
      none: 2,
    });
    expect(r.verdicts.leave).toEqual({
      ROUTE_TO_MANAGER: 1,
      ROUTE_TO_MANAGER_WITH_FLAGS: 0,
      ESCALATE_TO_HR: 1,
      RETURN_TO_EMPLOYEE: 0,
    });
    expect(r.verdicts.qa).toEqual({ AUTO_ANSWER: 1, ESCALATE_TO_HR: 1 });
    expect(r.verdicts.onboarding).toEqual({ AUTO: 0, MANAGER: 1 });
    expect(r.escalation).toEqual({ count: 4, rate: 0.5 });
    expect(r.cost.pricedRequests).toBe(6);
    expect(Math.abs(r.cost.totalUsd - 0.007)).toBeLessThan(1e-12);
    expect(Math.abs((r.cost.averageUsd ?? -1) - 0.007 / 6)).toBeLessThan(1e-12);
    expect(r.cost.tokens).toEqual({ input: 1500, output: 150 });
  });

  it('AT-21: no events give a zero-filled response with null rate and average', () => {
    const r = aggregate([], WINDOW);
    expect(AgentMetricsResponse.safeParse(r).success).toBe(true);
    expect(r.requests).toBe(0);
    expect(Object.values(r.byRoute).every((v) => v === 0)).toBe(true);
    expect(Object.keys(r.byRoute)).toHaveLength(7);
    expect(Object.values(r.verdicts.leave).every((v) => v === 0)).toBe(true);
    expect(Object.values(r.verdicts.qa).every((v) => v === 0)).toBe(true);
    expect(Object.values(r.verdicts.onboarding).every((v) => v === 0)).toBe(true);
    expect(r.escalation).toEqual({ count: 0, rate: null });
    expect(r.cost).toEqual({
      pricedRequests: 0,
      totalUsd: 0,
      averageUsd: null,
      tokens: { input: 0, output: 0 },
    });
  });

  it('AT-22: escalation criteria, each request counted once, 500s and retries excluded', () => {
    const count = (events: AuditEvent[]) => aggregate(events, WINDOW).escalation.count;
    expect(count([intake('req-1', { outcome: 'escalated', verdict: 'ESCALATE_TO_HR' })])).toBe(1);
    expect(
      count([
        chat('req-1', { outcome: 'retry' }),
        chat('req-2', { outcome: 'internal_error', label: null }),
      ]),
    ).toBe(0);
    const tryAudit = aggregate(
      [
        intake('req-1', {
          outcome: 'escalated',
          escalation: 'invalid_agent_output',
          internalError: true,
        }),
      ],
      WINDOW,
    );
    expect(tryAudit.escalation.count).toBe(0);
    expect(tryAudit.requests).toBe(1);
    expect(count([intake('req-1', { outcome: 'escalated', escalation: 'store_error' })])).toBe(0);
    expect(
      count([intake('req-1', { outcome: 'escalated', escalation: 'invalid_agent_output' })]),
    ).toBe(1);
  });

  it('AT-23: a duplicate requestId keeps the lowest event id at the same at', () => {
    const r = aggregate(
      [
        intake('req-1', { outcome: 'reply' }, { id: 'evt-2' }),
        intake('req-1', { outcome: 'escalated' }, { id: 'evt-1' }),
      ],
      WINDOW,
    );
    expect(r.requests).toBe(1);
    expect(r.escalation.count).toBe(1);
  });

  it('AT-24: all 12 chat outcomes count except a conversation_full conflict; all 8 intake outcomes count', () => {
    const outcomes = [
      'reply',
      'question',
      'leave_submitted',
      'leave_returned',
      'escalated',
      'retry',
      'answered',
      'escalated_to_hr',
      'checklist_created',
      'pending_manager',
      'internal_error',
      'conflict',
    ];
    const events = outcomes.map((o, i) => chat(`req-${String(i + 1)}`, { outcome: o }));
    events.push(
      chat('req-99', {
        outcome: 'conflict',
        escalation: 'conversation_full',
        usage: usage(5, 7, 7),
      }),
    );
    const r = aggregate(events, WINDOW);
    expect(r.requests).toBe(12);
    expect(r.cost.totalUsd).toBe(0);
    expect(r.cost.tokens).toEqual({ input: 0, output: 0 });

    const intakeOutcomes = [
      'reply',
      'question',
      'leave_submitted',
      'leave_returned',
      'escalated',
      'policy_answer',
      'policy_escalated',
      'onboarding_checklist',
    ];
    const ri = aggregate(
      intakeOutcomes.map((o, i) => intake(`req-${String(i + 1)}`, { outcome: o })),
      WINDOW,
    );
    expect(ri.requests).toBe(8);
  });

  it('AT-24: a lost-race conflict counts with its usage and is not an escalation', () => {
    const r = aggregate(
      [chat('req-1', { outcome: 'conflict', escalation: null, usage: usage(0.5, 10, 2) })],
      WINDOW,
    );
    expect(r.requests).toBe(1);
    expect(r.escalation.count).toBe(0);
    expect(r.cost.pricedRequests).toBe(1);
    expect(r.cost.totalUsd).toBe(0.5);
    expect(r.cost.tokens).toEqual({ input: 10, output: 2 });
  });

  it('AT-24b: byRoute for continue turns, classify-without-label and onboarding kinds', () => {
    const r = aggregate(
      [
        chat('req-1', { mode: 'continue', label: null }),
        chat('req-2', { mode: 'classify', label: null }),
        ev({
          kind: 'onboarding_created',
          requestId: 'req-3',
          verdict: 'AUTO',
          usage: usage(0, 0, 0),
        }),
        ev({
          kind: 'onboarding_create_escalated',
          requestId: 'req-4',
          reason: 'needs_details',
          usage: usage(0, 0, 0),
        }),
      ],
      WINDOW,
    );
    expect(r.byRoute.leave).toBe(1);
    expect(r.byRoute.none).toBe(1);
    expect(r.byRoute.onboarding).toBe(2);
    expect(r.requests).toBe(4);
    expect(r.verdicts.onboarding.AUTO).toBe(1);
  });

  it('AT-25: null and absent usage are unpriced; average is over priced requests only', () => {
    const legacy = intake('req-3');
    delete (legacy.payload as Rec).usage;
    const r = aggregate(
      [intake('req-1', { usage: usage(0.003, 3, 3) }), intake('req-2', { usage: null }), legacy],
      WINDOW,
    );
    expect(r.requests).toBe(3);
    expect(r.cost.pricedRequests).toBe(1);
    expect(r.cost.averageUsd).toBe(0.003);
    const none = aggregate([intake('req-1', { usage: null }), legacy], WINDOW);
    expect(none.cost.averageUsd).toBeNull();
    expect(none.cost.totalUsd).toBe(0);
  });

  it('AT-25: a zero-cost priced request lowers the average', () => {
    const r = aggregate(
      [intake('req-1', { usage: usage(0.004, 1, 1) }), intake('req-2', { usage: usage(0, 0, 0) })],
      WINDOW,
    );
    expect(r.cost.pricedRequests).toBe(2);
    expect(r.cost.averageUsd).toBe(0.002);
  });

  it('AT-26: a legacy intake event without qaVerdict, onboardingVerdict or usage still counts', () => {
    const legacy = ev({
      kind: 'intake_outcome',
      requestId: 'req-1',
      actorRole: 'employee',
      label: 'leave',
      outcome: 'leave_submitted',
      escalation: null,
      verdict: 'ROUTE_TO_MANAGER',
    });
    const r = aggregate([legacy], WINDOW);
    expect(r.requests).toBe(1);
    expect(Object.values(r.verdicts.qa).every((v) => v === 0)).toBe(true);
    expect(r.verdicts.leave.ROUTE_TO_MANAGER).toBe(1);
    expect(r.cost.pricedRequests).toBe(0);
  });

  it('AT-26: a summary event with an unknown outcome or no requestId makes aggregate throw', () => {
    expect(() => aggregate([intake('req-1', { outcome: 'approved' })], WINDOW)).toThrow();
    const noId = intake('req-1');
    delete (noId.payload as Rec).requestId;
    expect(() => aggregate([noId], WINDOW)).toThrow();
  });

  it('AT-27: the response carries no emp-, req- or checklist id, and is deterministic', () => {
    const a = aggregate(AT20, WINDOW);
    const b = aggregate(AT20, WINDOW);
    expect(a).toEqual(b);
    const text = JSON.stringify(a);
    expect(text).not.toContain('emp-');
    expect(text).not.toContain('req-');
    expect(text).not.toContain('chk-');
  });
});
