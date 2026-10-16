// Append-only audit store on MongoDB (spec mongo-persistence, rule 7; domain-schemas D-9).
// Inserts are the only write. Events are kept forever for the MVP (D-1); there is no TTL.
import type { AuditSink } from '../../agents/audit.js';
import { AuditEvent } from '../../domain/schemas.js';
import type { AuditReader } from '../../http/approvals/ports.js';
import { AuditEventModel } from '../../models/index.js';
import { literal, NO_STORAGE_KEYS, parseAllStored } from './read.js';

export class MongoAuditStore implements AuditSink, AuditReader {
  /** Any failure rejects, so the runtime and intake fail closed (agent-runtime D-14). */
  async write(event: AuditEvent): Promise<void> {
    await AuditEventModel.create(AuditEvent.parse(event));
  }

  /** One trace's events in insertion order: `_id` order from one process (D-12). */
  async listByTrace(traceId: string): Promise<AuditEvent[]> {
    const docs = await AuditEventModel.find({ traceId: literal(traceId) }, NO_STORAGE_KEYS)
      .sort({ _id: 1 })
      .lean()
      .exec();
    return parseAllStored(AuditEvent, 'auditEvents', docs);
  }
}
