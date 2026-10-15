import { describe, expect, it } from 'vitest';
import { ENTITY_SCHEMAS } from '../domain/schemas.js';
import { AuditEventModel, MODELS } from './index.js';

type EntityKey = keyof typeof ENTITY_SCHEMAS;

function shapeKeys(key: EntityKey): string[] {
  const schema = ENTITY_SCHEMAS[key] as unknown as { shape: Record<string, unknown> };
  return Object.keys(schema.shape).sort();
}

describe('models', () => {
  it('AT-17: model paths match the Zod schema top-level keys', () => {
    expect(Object.keys(MODELS).sort()).toEqual(Object.keys(ENTITY_SCHEMAS).sort());
    for (const key of Object.keys(ENTITY_SCHEMAS) as EntityKey[]) {
      const paths = new Set<string>();
      for (const p of Object.keys(MODELS[key].schema.paths)) {
        if (p === '_id' || p === '__v') continue;
        paths.add(p.split('.')[0] ?? p);
      }
      expect([...paths].sort(), key).toEqual(shapeKeys(key));
    }
  });

  it('AT-29: AuditEventModel rejects every update and delete operation as append-only', async () => {
    const ops: Record<string, () => Promise<unknown>> = {
      updateOne: () => AuditEventModel.updateOne({ id: 'ae-001' }, { traceId: 'x' }).exec(),
      updateMany: () => AuditEventModel.updateMany({}, { traceId: 'x' }).exec(),
      findOneAndUpdate: () =>
        AuditEventModel.findOneAndUpdate({ id: 'ae-001' }, { traceId: 'x' }).exec(),
      replaceOne: () => AuditEventModel.replaceOne({ id: 'ae-001' }, { traceId: 'x' }).exec(),
      deleteOne: () => AuditEventModel.deleteOne({ id: 'ae-001' }).exec(),
      deleteMany: () => AuditEventModel.deleteMany({}).exec(),
      findOneAndDelete: () => AuditEventModel.findOneAndDelete({ id: 'ae-001' }).exec(),
    };
    for (const [name, run] of Object.entries(ops)) {
      await expect(run(), name).rejects.toThrow(/append-only/);
    }
  });
});
