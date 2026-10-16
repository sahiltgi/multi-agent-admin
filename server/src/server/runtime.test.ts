// AT-16 (specs/mongo-persistence.md rule 12, D-17): production ids are unguessable.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Id, IsoDateTime } from '../domain/schemas.js';
import { systemClock, timerScheduler, uuidIdGen } from './runtime.js';

const D17 = /^req-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('runtime wiring', () => {
  it('AT-16: 1000 ids are distinct, parse as Id and match the D-17 format', () => {
    const ids = Array.from({ length: 1000 }, () => uuidIdGen());
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) {
      expect(Id.safeParse(id).success).toBe(true);
      expect(id).toMatch(D17);
    }
  });

  it('AT-16: server wiring sources use no Math.random and no counter for ids', () => {
    const dir = import.meta.dirname;
    expect(existsSync(join(dir, 'runtime.ts'))).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('Math.random');
    }
    const runtime = readFileSync(join(dir, 'runtime.ts'), 'utf8');
    expect(runtime).toContain('randomUUID');
    expect(runtime).not.toMatch(/\+\+|\+=\s*1\b/);
  });

  it('AT-16: systemClock reads the real clock and timerScheduler returns a working cancel', async () => {
    const before = Date.now();
    const ms = systemClock.nowMs();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now());
    expect(IsoDateTime.safeParse(systemClock.nowIso()).success).toBe(true);

    let fired = 0;
    const cancel = timerScheduler.setTimeout(() => {
      fired += 1;
    }, 5);
    const kept = timerScheduler.setTimeout(() => {
      fired += 10;
    }, 5);
    cancel();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(fired).toBe(10);
    kept();
  });
});
