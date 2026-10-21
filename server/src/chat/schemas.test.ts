// specs/chat-endpoint.md: AT-3 (ChatBody), AT-8 (Conversation.parse failures, storage-only schema)
// and AT-27 (ChatResponse refine). Schemas load dynamically so each test fails on its own.
import { describe, expect, it } from 'vitest';
import { ENTITY_SCHEMAS } from '../domain/schemas.js';

const T = '2026-10-16T09:00:00Z';
const turn = (i: number) => ({
  requestId: `t-${String(i)}`,
  at: T,
  userText: 'hi',
  reply: 'ok',
  status: 'reply',
});
const conv = (extra: Record<string, unknown> = {}) => ({
  id: 'c-1',
  userId: 'emp-004',
  turns: [turn(1)],
  activeAgent: null,
  draft: null,
  version: 0,
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const DRAFT = { messages: ['m'], lastQuestion: 'Which dates?' };

describe('chat schemas', () => {
  it('AT-3: ChatBody is strict, trims and caps the message at 4000 characters', async () => {
    const { ChatBody } = await import('./schemas.js');
    expect(ChatBody.parse({ message: '  hi  ' })).toEqual({ message: 'hi' });
    expect(ChatBody.safeParse({ message: 'x'.repeat(4000) }).success).toBe(true);
    for (const bad of [
      {},
      { message: '   ' },
      { message: 'x'.repeat(4001) },
      { text: 'hi' },
      { message: 'hi', approved: true },
      { message: 'hi', idempotencyKey: 'k-1' },
      { message: 'hi', conversationId: '' },
    ]) {
      expect(ChatBody.safeParse(bad).success).toBe(false);
    }
  });

  it('AT-8: Conversation.parse accepts a valid document and rejects the four invalid shapes', async () => {
    const { Conversation } = await import('./schemas.js');
    expect(Conversation.safeParse(conv()).success).toBe(true);
    expect(Conversation.safeParse(conv({ activeAgent: 'leave', draft: DRAFT })).success).toBe(true);
    expect(Conversation.safeParse(conv({ activeAgent: 'policy_qa', draft: DRAFT })).success).toBe(
      false,
    );
    expect(Conversation.safeParse(conv({ activeAgent: 'leave', draft: null })).success).toBe(false);
    expect(Conversation.safeParse(conv({ extra: 1 })).success).toBe(false);
    expect(
      Conversation.safeParse(conv({ turns: Array.from({ length: 51 }, (_, i) => turn(i)) }))
        .success,
    ).toBe(false);
    expect(
      Conversation.safeParse(conv({ turns: Array.from({ length: 50 }, (_, i) => turn(i)) }))
        .success,
    ).toBe(true);
  });

  it('AT-8: Conversation is storage-only, outside ENTITY_SCHEMAS (still exactly 8 keys)', async () => {
    const { Conversation } = await import('./schemas.js');
    expect(Conversation).toBeDefined();
    expect(Object.keys(ENTITY_SCHEMAS)).toHaveLength(8);
    expect(Object.keys(ENTITY_SCHEMAS)).not.toContain('Conversation');
  });

  it('AT-36: ChatTurnPayload.escalation is a closed union of ChatEscalationCode and DispatchEscalation', async () => {
    const { ChatTurnPayload, ChatEscalationCode } = await import('./schemas.js');
    const { DispatchEscalation } = await import('../intake/schemas.js');
    const payload = (escalation: unknown): Record<string, unknown> => ({
      kind: 'chat_turn',
      requestId: 'r-1',
      conversationId: 'c-1',
      conversationCreated: false,
      mode: 'classify',
      handedBack: false,
      actorRole: 'employee',
      label: null,
      routingSource: null,
      leaveResult: null,
      outcome: 'reply',
      escalation,
      handedBackFrom: null,
      taskActiveBefore: false,
      taskActiveAfter: false,
      draftMessageCount: 0,
      leaveRequestId: null,
      approvalItemId: null,
      assigneeRole: null,
      assigneeId: null,
      flagged: null,
      verdict: null,
      policyVersion: null,
      policyHash: null,
      qaVerdict: null, // policy-qa amendment
      policyQuestionId: null, // policy-qa amendment
      injectionSuspected: false,
    });
    expect(ChatTurnPayload.safeParse(payload('free text')).success).toBe(false);
    expect(ChatTurnPayload.safeParse(payload(null)).success).toBe(true);
    for (const code of ChatEscalationCode.options) {
      expect(ChatTurnPayload.safeParse(payload(code)).success, code).toBe(true);
    }
    for (const code of DispatchEscalation.options) {
      expect(ChatTurnPayload.safeParse(payload(code)).success, code).toBe(true);
    }
  });

  it('AT-27:ChatResponse requires a card exactly for leave_submitted and leave_returned, and is strict', async () => {
    const { ChatResponse } = await import('./schemas.js');
    const base = { reply: 'r', requestId: 'r-1', conversationId: 'c-1' };
    const returned = { kind: 'returned', failedRules: [{ ruleId: 'dates_valid', message: 'm' }] };
    const submitted = {
      kind: 'submitted',
      request: {
        requestId: 'r-1',
        leaveType: 'annual',
        startDate: '2026-11-16',
        endDate: '2026-11-18',
        status: 'pending_approval',
        approvalStatus: 'open',
        decision: null,
        createdAt: T,
      },
      verdict: 'ROUTE_TO_MANAGER',
      failedRules: [],
    };
    const answered = { kind: 'policy_answer', sectionIds: ['HB-1.2'] };
    expect(ChatResponse.safeParse({ ...base, status: 'answered', card: answered }).success).toBe(
      true,
    );
    expect(ChatResponse.safeParse({ ...base, status: 'answered' }).success).toBe(false);
    expect(
      ChatResponse.safeParse({ ...base, status: 'escalated_to_hr', card: answered }).success,
    ).toBe(false);
    expect(ChatResponse.safeParse({ ...base, status: 'escalated_to_hr' }).success).toBe(true);
    expect(ChatResponse.safeParse({ ...base, status: 'reply' }).success).toBe(true);
    expect(
      ChatResponse.safeParse({ ...base, status: 'leave_returned', card: returned }).success,
    ).toBe(true);
    expect(
      ChatResponse.safeParse({ ...base, status: 'leave_submitted', card: submitted }).success,
    ).toBe(true);
    expect(ChatResponse.safeParse({ ...base, status: 'leave_submitted' }).success).toBe(false);
    expect(
      ChatResponse.safeParse({ ...base, status: 'leave_returned', card: submitted }).success,
    ).toBe(false);
    expect(ChatResponse.safeParse({ ...base, status: 'reply', card: returned }).success).toBe(
      false,
    );
    expect(
      ChatResponse.safeParse({ ...base, status: 'reply', verdict: 'ROUTE_TO_MANAGER' }).success,
    ).toBe(false);
  });
});
