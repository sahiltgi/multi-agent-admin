// specs/policy-qa.md AT-42 (in-memory half, runs without MongoDB): the PolicyQuestionStore
// contract and the QA escalation text loader. The Mongo half is in adapters.integration.test.ts.
import { describe, expect, it } from 'vitest';
import type { PolicyQuestion } from '../domain/qa.js';
import { InMemoryPolicyQuestionStore, InMemoryQaTexts } from './in-memory.js';

const H = 'a'.repeat(64);
const mk = (id: string, over: Partial<PolicyQuestion> = {}): PolicyQuestion => ({
  id,
  employeeId: 'emp-004',
  question: 'Who do I tell about bullying by a colleague?',
  draftAnswer: 'You get 10 sick days per year.',
  escalation: 'stop_reason',
  gateResult: null,
  policyVersion: 'v1',
  policyHash: H,
  handbookHash: H,
  createdAt: '2026-10-19T09:00:00Z',
  ...over,
});

describe('policy-qa AT-42: InMemoryPolicyQuestionStore', () => {
  it('AT-42: insert never overwrites, get returns the record or null, remove deletes it', async () => {
    const store = new InMemoryPolicyQuestionStore();
    const q = mk('r-1');
    expect(await store.insert(q)).toBe(true);
    expect(await store.insert({ ...q, question: 'changed' })).toBe(false);
    expect(await store.get('r-1')).toEqual(q);
    expect(await store.get('r-2')).toBeNull();
    expect(await store.get('{"$ne":null}')).toBeNull();
    await store.remove('r-1');
    expect(await store.get('r-1')).toBeNull();
  });

  it('AT-42: reads and writes clone, so callers never share state', async () => {
    const store = new InMemoryPolicyQuestionStore();
    const q = mk('r-1');
    await store.insert(q);
    q.question = 'mutated after insert';
    const got = await store.get('r-1');
    expect(got?.question).toBe('Who do I tell about bullying by a colleague?');
    if (got) got.question = 'mutated after get';
    expect((await store.get('r-1'))?.question).toBe('Who do I tell about bullying by a colleague?');
  });
});

describe('policy-qa AT-42: InMemoryQaTexts', () => {
  it('AT-42: a missing or blank escalated text loads as null', async () => {
    expect(await new InMemoryQaTexts({ escalated: 'QA-ESCALATED-FIXTURE' }).load('escalated')).toBe(
      'QA-ESCALATED-FIXTURE',
    );
    expect(await new InMemoryQaTexts({}).load('escalated')).toBeNull();
    expect(await new InMemoryQaTexts({ escalated: '  \n' }).load('escalated')).toBeNull();
  });
});
