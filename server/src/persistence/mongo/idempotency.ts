// IdempotencyStore on MongoDB (spec mongo-persistence, rule 6; D-16; request-intake D-11).
// Same observable behaviour as InMemoryIdempotencyStore. Liveness is decided from the caller's
// nowIso only: an entry is live while nowIso < claimedAt + 24 h, so it expires at exactly 24 h.
import type { IdempotencyBegin, IdempotencyStore } from '../../intake/ports.js';
import { IdempotencyDone, IdempotencyRecord, IdempotencyRecordModel } from './models.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseStored } from './read.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function slot(employeeId: string, key: string) {
  return { employeeId: literal(employeeId), key: literal(key) };
}

export class MongoIdempotencyStore implements IdempotencyStore {
  /**
   * One atomic upsert: it matches only an expired entry (and renews it) or inserts a new one.
   * A live entry makes the insert hit the unique (employeeId, key) index, so of concurrent
   * callers on one free slot exactly one gets `new`.
   */
  async begin(
    employeeId: string,
    key: string,
    textHash: string,
    nowIso: string,
  ): Promise<IdempotencyBegin> {
    const nowMs = Date.parse(nowIso);
    const claim = IdempotencyRecord.parse({
      employeeId,
      key,
      textHash,
      claimedAt: nowIso,
      expiresAt: new Date(nowMs + DAY_MS),
      done: null,
    });
    try {
      await IdempotencyRecordModel.findOneAndUpdate(
        { ...slot(employeeId, key), expiresAt: { $lte: new Date(nowMs) } },
        {
          $set: {
            textHash: claim.textHash,
            claimedAt: claim.claimedAt,
            expiresAt: claim.expiresAt,
            done: null,
          },
        },
        { upsert: true },
      ).exec();
      return { kind: 'new' };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const doc = await IdempotencyRecordModel.findOne(slot(employeeId, key), NO_STORAGE_KEYS)
      .lean()
      .exec();
    if (doc === null) return { kind: 'conflict' }; // released between the two calls
    const entry = parseStored(IdempotencyRecord, 'idempotencyRecords', doc);
    if (entry.textHash !== textHash || entry.done === null) return { kind: 'conflict' };
    return { kind: 'replay', status: entry.done.status, body: entry.done.body };
  }

  async complete(employeeId: string, key: string, status: number, body: unknown): Promise<void> {
    const done = IdempotencyDone.parse({ status, body });
    await IdempotencyRecordModel.updateOne(slot(employeeId, key), { $set: { done } }).exec();
  }

  async release(employeeId: string, key: string): Promise<void> {
    await IdempotencyRecordModel.deleteOne(slot(employeeId, key)).exec();
  }
}
