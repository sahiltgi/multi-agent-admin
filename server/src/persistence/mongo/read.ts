// Shared read and write helpers for the MongoDB adapters (spec mongo-persistence, rule 1; D-13).
// Reads are lean, drop `_id` and `__v`, and are parsed with the strict schema before returning.
import type { z } from 'zod';

/** Projection for every lean read: storage keys never reach a caller. */
export const NO_STORAGE_KEYS = { _id: 0, __v: 0 } as const;

/** Thrown when a stored document fails its schema. Names the collection and id only (D-13). */
export class StoredDocumentError extends Error {
  constructor(collection: string, id: string) {
    super(`stored ${collection} document ${id} failed validation`);
    this.name = 'StoredDocumentError';
  }
}

function storedId(doc: unknown): string {
  if (typeof doc === 'object' && doc !== null) {
    for (const key of ['id', 'requestId', 'key', 'date']) {
      const value: unknown = (doc as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return '(unknown)';
}

export function parseStored<S extends z.ZodType>(
  schema: S,
  collection: string,
  doc: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(doc);
  if (!parsed.success) throw new StoredDocumentError(collection, storedId(doc));
  return parsed.data;
}

export function parseAllStored<S extends z.ZodType>(
  schema: S,
  collection: string,
  docs: readonly unknown[],
): z.infer<S>[] {
  return docs.map((d) => parseStored(schema, collection, d));
}

/**
 * Ids from callers are compared as literals only (rule 1): under `$eq`, a value such as
 * `{"$ne":null}` or `.*` is matched as data, never read as an operator or a regex.
 */
export function literal<T extends string>(value: T): { $eq: T } {
  return { $eq: value };
}

/** MongoDB's duplicate-key error code, from a unique index. */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
