// Append-only audit store on MongoDB (spec mongo-persistence, rule 7; domain-schemas D-9).
// Inserts are the only write. Events are kept forever for the MVP (D-1); there is no TTL.
import { z } from 'zod';
import type { AuditSink } from '../../agents/audit.js';
import { AuditEvent, IsoDateTime } from '../../domain/schemas.js';
import type { AuditReader } from '../../http/approvals/ports.js';
import { SUMMARY_KINDS, type AuditSummaryReader, type SummaryKind } from '../../metrics/ports.js';
import { AuditEventModel } from '../../models/index.js';
import { literal, NO_STORAGE_KEYS, parseAllStored } from './read.js';

export class MongoAuditStore implements AuditSink, AuditReader, AuditSummaryReader {
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

  /**
   * Summary events in [from, to] by canonical UTC `at` (spec agent-metrics, rule 15), served by the
   * { 'payload.kind': 1, at: 1 } index. The kinds are a closed enum and the bounds are strings.
   */
  async listByKinds(
    kinds: readonly SummaryKind[],
    from: string,
    to: string,
  ): Promise<AuditEvent[]> {
    if (kinds.length === 0) return [];
    // Second guard behind the route: only known kinds and canonical datetime strings reach the filter.
    const known = z.array(z.enum(SUMMARY_KINDS)).parse(kinds);
    const bounds = z.tuple([IsoDateTime, IsoDateTime]).parse([from, to]);
    const docs = await AuditEventModel.find(
      { 'payload.kind': { $in: known }, at: { $gte: bounds[0], $lte: bounds[1] } },
      NO_STORAGE_KEYS,
    )
      .sort({ at: 1, _id: 1 })
      .lean()
      .exec();
    return parseAllStored(AuditEvent, 'auditEvents', docs);
  }
}
