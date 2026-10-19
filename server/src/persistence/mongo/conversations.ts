// ConversationStore on MongoDB (spec chat-endpoint rule 7; D-4, D-5). Same observable behaviour
// as InMemoryConversationStore. Every filter matches id and userId as literals, and
// saveIfVersion is one single-document replace filtered on the expected version, so of
// concurrent saves on one version exactly one wins.
import type { ConversationStore } from '../../chat/ports.js';
import { Conversation } from '../../chat/schemas.js';
import { ConversationModel } from './models.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseStored } from './read.js';

const owned = (id: string, userId: string) => ({ id: literal(id), userId: literal(userId) });

export class MongoConversationStore implements ConversationStore {
  async get(id: string, userId: string): Promise<Conversation | null> {
    const doc = await ConversationModel.findOne(owned(id, userId), NO_STORAGE_KEYS).lean().exec();
    return doc === null ? null : parseStored(Conversation, 'conversations', doc);
  }

  async insert(conversation: Conversation): Promise<boolean> {
    const doc = Conversation.parse(conversation);
    try {
      await ConversationModel.create(doc);
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async saveIfVersion(conversation: Conversation, expectedVersion: number): Promise<boolean> {
    const doc = Conversation.parse(conversation);
    if (doc.version !== expectedVersion + 1) return false;
    const res = await ConversationModel.replaceOne(
      { ...owned(doc.id, doc.userId), version: { $eq: expectedVersion } },
      doc,
    ).exec();
    return res.matchedCount === 1;
  }

  async remove(id: string, userId: string): Promise<void> {
    await ConversationModel.deleteOne(owned(id, userId)).exec();
  }
}
