// Ports for the chat endpoint (spec chat-endpoint rule 7; D-5). Routes depend only on these; the
// in-memory store is in ./in-memory.ts and MongoConversationStore in persistence/mongo/.
import type { IntakeDeps } from '../intake/ports.js';
import type { ChatTextKey, Conversation } from './schemas.js';

export interface ConversationStore {
  /** The conversation only when both id and userId match exactly; otherwise null (rule 5). */
  get(id: string, userId: string): Promise<Conversation | null>;
  /** Adds a new conversation; false if the id exists, never overwrites. */
  insert(conversation: Conversation): Promise<boolean>;
  /** Atomic: replaces the stored copy only if its version is expectedVersion (rule 20). */
  saveIfVersion(conversation: Conversation, expectedVersion: number): Promise<boolean>;
  /** Compensation only (D-5): deletes the one document matching both id and userId. */
  remove(id: string, userId: string): Promise<void>;
}

export type ChatTextLoadResult = { found: true; text: string } | { found: false };

export interface ChatTextLoader {
  /** The fixed text, or not found when it is missing or blank (fail closed, rule 21). */
  load(key: ChatTextKey): Promise<ChatTextLoadResult>;
}

export interface ChatDeps {
  intake: IntakeDeps; // shared with POST /messages (rule 25)
  conversations: ConversationStore;
  texts: ChatTextLoader;
}
