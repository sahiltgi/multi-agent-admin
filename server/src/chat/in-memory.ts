// In-memory ConversationStore (spec chat-endpoint rule 7). Same observable behaviour as
// MongoConversationStore: documents are parsed on the way in, copied on the way out, and matched
// on id and userId together. Used by unit tests and local wiring tests.
import type { ConversationStore } from './ports.js';
import { Conversation } from './schemas.js';

export class InMemoryConversationStore implements ConversationStore {
  private readonly docs = new Map<string, Conversation>();

  get(id: string, userId: string): Promise<Conversation | null> {
    const doc = this.docs.get(id);
    return Promise.resolve(doc?.userId === userId ? structuredClone(doc) : null);
  }

  insert(conversation: Conversation): Promise<boolean> {
    const doc = Conversation.parse(conversation);
    if (this.docs.has(doc.id)) return Promise.resolve(false);
    this.docs.set(doc.id, structuredClone(doc));
    return Promise.resolve(true);
  }

  saveIfVersion(conversation: Conversation, expectedVersion: number): Promise<boolean> {
    const doc = Conversation.parse(conversation);
    const stored = this.docs.get(doc.id);
    if (
      stored?.userId !== doc.userId ||
      stored.version !== expectedVersion ||
      doc.version !== expectedVersion + 1
    ) {
      return Promise.resolve(false);
    }
    this.docs.set(doc.id, structuredClone(doc));
    return Promise.resolve(true);
  }

  remove(id: string, userId: string): Promise<void> {
    if (this.docs.get(id)?.userId === userId) this.docs.delete(id);
    return Promise.resolve();
  }
}
