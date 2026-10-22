import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ClarifyingQuestion,
  FallbackReason,
  FixedMessageKey,
  OrchestratorEvalCase,
  OrchestratorFailure,
  OrchestratorInput,
  RoutingDecision,
  RouteInput,
  RouteLabel,
  RouteOutput,
} from './schemas.js';

type Rec = Record<string, unknown>;

const LABELS = ['leave', 'policy_qa', 'onboarding', 'prohibited', 'out_of_scope', 'unclear'];

const base = {
  requestId: 'req-1',
  model: 'claude-haiku-5-5',
  promptVersion: 'v1',
  source: 'model',
  fallbackReason: null,
};

const arms: Rec[] = [
  { ...base, label: 'leave', targetAgent: 'leave' },
  { ...base, label: 'policy_qa', targetAgent: 'policy_qa' },
  { ...base, label: 'onboarding', targetAgent: 'onboarding' },
  { ...base, label: 'prohibited', reply: 'Please contact HR directly.' },
  { ...base, label: 'out_of_scope', reply: 'That is outside what I can help with.' },
  { ...base, label: 'unclear', clarifyingQuestion: 'What do you need help with?' },
];

describe('orchestrator schemas', () => {
  it('AT-1: RouteLabel accepts the six labels and rejects everything else', () => {
    for (const l of LABELS) expect(RouteLabel.safeParse(l).success).toBe(true);
    for (const bad of ['approved', 'Leave', 'hr', '']) {
      expect(RouteLabel.safeParse(bad).success).toBe(false);
    }
  });

  it('AT-1: RouteInput is strict and takes only a label', () => {
    expect(RouteInput.safeParse({ label: 'leave' }).success).toBe(true);
    expect(RouteInput.safeParse({ label: 'approved' }).success).toBe(false);
    expect(RouteInput.safeParse({ label: 'leave', approved: true }).success).toBe(false);
    expect(RouteInput.safeParse({}).success).toBe(false);
  });

  it('AT-11: RouteInput has no confidence field (D-3)', () => {
    expect(RouteInput.safeParse({ label: 'leave', confidence: 0.9 }).success).toBe(false);
  });

  it('AT-15: RouteInput has no clarifyingQuestion field (D-2)', () => {
    const q = 'Which dates do you need off?';
    expect(RouteInput.safeParse({ label: 'unclear', clarifyingQuestion: q }).success).toBe(false);
    expect(RouteInput.safeParse({ label: 'unclear' }).success).toBe(true);
  });

  it('AT-6: RouteOutput echoes the label (D-9) and is strict', () => {
    expect(RouteOutput.safeParse({ accepted: true, label: 'leave' }).success).toBe(true);
    expect(RouteOutput.safeParse({ accepted: true }).success).toBe(false);
    expect(RouteOutput.safeParse({ accepted: true, label: 'approved' }).success).toBe(false);
    expect(RouteOutput.safeParse({ accepted: true, label: 'leave', x: 1 }).success).toBe(false);
  });

  it('AT-7: FallbackReason has only the three reasons that remain after D-2 and D-3', () => {
    for (const r of ['run_not_completed', 'no_route_call', 'multiple_route_calls']) {
      expect(FallbackReason.safeParse(r).success).toBe(true);
    }
    for (const r of ['invalid_clarifying_question', 'low_confidence']) {
      expect(FallbackReason.safeParse(r).success).toBe(false);
    }
  });

  it('AT-25: ClarifyingQuestion is trimmed, 1-200 chars, exactly one ? and it is last (D-13)', () => {
    expect(ClarifyingQuestion.safeParse('Which dates do you need off?').success).toBe(true);
    expect(ClarifyingQuestion.safeParse('Which dates? And which type?').success).toBe(false);
    expect(ClarifyingQuestion.safeParse('Tell me more.').success).toBe(false);
    expect(ClarifyingQuestion.safeParse('Really? Tell me.').success).toBe(false);
    expect(ClarifyingQuestion.safeParse('').success).toBe(false);
    expect(ClarifyingQuestion.safeParse(`${'x'.repeat(200)}?`).success).toBe(false);
    expect(ClarifyingQuestion.safeParse(`${'x'.repeat(199)}?`).success).toBe(true);
  });

  it('AT-25: FixedMessageKey is the three message keys', () => {
    for (const k of ['prohibited', 'out_of_scope', 'fallback_question']) {
      expect(FixedMessageKey.safeParse(k).success).toBe(true);
    }
    expect(FixedMessageKey.safeParse('other').success).toBe(false);
  });

  it('AT-18: every RoutingDecision arm parses and rejects verdict, approved and decision keys', () => {
    expect(arms).toHaveLength(6);
    for (const arm of arms) {
      expect(RoutingDecision.safeParse(arm).success).toBe(true);
      for (const k of ['verdict', 'approved', 'decision']) {
        expect(RoutingDecision.safeParse({ ...arm, [k]: 'APPROVE' }).success).toBe(false);
      }
    }
  });

  it('AT-13: prohibited and unclear arms carry no targetAgent', () => {
    expect(
      RoutingDecision.safeParse({ ...base, label: 'prohibited', reply: 'x', targetAgent: 'leave' })
        .success,
    ).toBe(false);
    expect(
      RoutingDecision.safeParse({ ...base, label: 'leave', targetAgent: 'policy_qa' }).success,
    ).toBe(false);
  });

  it('AT-14: OrchestratorFailure is the strict fail-closed shape (D-6)', () => {
    const f = {
      requestId: 'req-1',
      outcome: 'error',
      code: 'fixed_message_missing',
      key: 'prohibited',
      escalate: true,
    };
    expect(OrchestratorFailure.safeParse(f).success).toBe(true);
    expect(OrchestratorFailure.safeParse({ ...f, escalate: false }).success).toBe(false);
    expect(OrchestratorFailure.safeParse({ ...f, key: 'nope' }).success).toBe(false);
    expect(OrchestratorFailure.safeParse({ ...f, reply: 'model text' }).success).toBe(false);
    const a = { requestId: 'req-1', outcome: 'error', code: 'audit_failed', escalate: true };
    expect(OrchestratorFailure.safeParse(a).success).toBe(true);
    expect(OrchestratorFailure.safeParse({ ...a, key: 'prohibited' }).success).toBe(false);
    expect(OrchestratorFailure.safeParse({ ...a, escalate: false }).success).toBe(false);
  });

  it('D-14: OrchestratorInput requires agentId orchestrator and empty documents (D-14)', () => {
    const input = {
      requestId: 'req-1',
      agentId: 'orchestrator',
      actor: { employeeId: 'emp-004', role: 'employee' },
      userText: 'I need leave',
      documents: [],
    };
    expect(OrchestratorInput.safeParse(input).success).toBe(true);
    expect(OrchestratorInput.safeParse({ ...input, agentId: 'leave' }).success).toBe(false);
    expect(
      OrchestratorInput.safeParse({ ...input, documents: [{ docId: 'doc-1', text: 'x' }] }).success,
    ).toBe(false);
  });

  it('AT-26 (amended by the eval growth): cases.jsonl holds orch-001 to orch-040 and covers every label', () => {
    const path = fileURLToPath(
      new URL('../../../../evals/orchestrator/cases.jsonl', import.meta.url),
    );
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(40);
    const cases = lines.map((l) => OrchestratorEvalCase.parse(JSON.parse(l)));
    expect(cases.map((c) => c.id)).toEqual(
      Array.from({ length: 40 }, (_, i) => `orch-${String(i + 1).padStart(3, '0')}`),
    );
    expect(new Set(cases.map((c) => c.expected.label))).toEqual(new Set(LABELS));
    expect(cases.some((c) => c.category === 'injection')).toBe(true);
    expect(cases.some((c) => c.tags.includes('mixed'))).toBe(true);
  });

  it('AT-26: OrchestratorEvalCase is strict and checks the id format', () => {
    const c = {
      id: 'orch-001',
      category: 'routing',
      actor: { employeeId: 'emp-004', role: 'employee' },
      userText: 'Synthetic text',
      expected: { label: 'leave', injectionFlagged: false },
      tags: [],
    };
    expect(OrchestratorEvalCase.safeParse(c).success).toBe(true);
    expect(OrchestratorEvalCase.safeParse({ ...c, id: 'orch-1' }).success).toBe(false);
    expect(OrchestratorEvalCase.safeParse({ ...c, extra: 1 }).success).toBe(false);
    expect(OrchestratorEvalCase.safeParse({ ...c, category: 'verdict' }).success).toBe(false);
    expect(OrchestratorEvalCase.safeParse({ ...c, tags: ['Bad Tag'] }).success).toBe(false);
  });
});
