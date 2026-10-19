// specs/chat-endpoint.md AT-8: the ConversationStore contract against InMemoryConversationStore.
// The same cases run against MongoConversationStore in persistence/mongo/adapters.integration.test.ts.
import { describe, expect, it } from 'vitest';
import type { Conversation } from './schemas.js';
import type { ConversationStore } from './ports.js';

const T = '2026-10-16T09:00:00Z';
const mk = (extra: Record<string, unknown> = {}): Conversation => ({
  id: 'c-1',
  userId: 'emp-004',
  turns: [{ requestId: 't-1', at: T, userText: 'hi', reply: 'ok', status: 'reply' }],
  activeAgent: null,
  draft: null,
  version: 0,
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const next = (c: Conversation, note: string): Conversation => ({
  ...c,
  version: c.version + 1,
  updatedAt: T,
  turns: [...c.turns, { requestId: note, at: T, userText: note, reply: 'ok', status: 'reply' }],
});

describe('InMemoryConversationStore', () => {
  const make = async (): Promise<ConversationStore> => {
    const { InMemoryConversationStore } = await import('./in-memory.js');
    return new InMemoryConversationStore();
  };

  it('AT-8: get matches id and userId exactly and returns a clean copy', async () => {
    const s = await make();
    const c = mk();
    expect(await s.insert(c)).toBe(true);
    expect(await s.get('c-1', 'emp-004')).toEqual(c);
    expect(await s.get('c-1', 'emp-005')).toBeNull();
    expect(await s.get('{"$ne":null}', 'emp-004')).toBeNull();
  });

  it('AT-8: a second insert with the same id returns false and changes nothing', async () => {
    const s = await make();
    const c = mk();
    await s.insert(c);
    expect(await s.insert(mk({ userId: 'emp-005', version: 7 }))).toBe(false);
    expect(await s.get('c-1', 'emp-004')).toEqual(c);
  });

  it('AT-8: saveIfVersion succeeds once for an expected version', async () => {
    const s = await make();
    const c = mk();
    await s.insert(c);
    expect(await s.saveIfVersion(next(c, 'a'), 0)).toBe(true);
    expect(await s.saveIfVersion(next(c, 'b'), 0)).toBe(false);
    expect((await s.get('c-1', 'emp-004'))?.version).toBe(1);
  });

  it('AT-8: of 10 concurrent saveIfVersion calls with one expected version exactly one wins', async () => {
    const s = await make();
    const c = mk();
    await s.insert(c);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.saveIfVersion(next(c, `n${String(i)}`), 0)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('AT-8: remove deletes only the document matching both id and userId', async () => {
    const s = await make();
    await s.insert(mk());
    await s.remove('c-1', 'emp-005');
    expect(await s.get('c-1', 'emp-004')).not.toBeNull();
    await s.remove('c-1', 'emp-004');
    expect(await s.get('c-1', 'emp-004')).toBeNull();
  });
});
