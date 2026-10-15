import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { SeedSummary } from '../domain/schemas.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const EXPECTED = { teams: 3, employees: 20, leaveBalances: 120, holidays: 6, leaveRequests: 5 };

async function collectionCounts(uri: string): Promise<Record<string, number>> {
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    const db = conn.db;
    if (!db) throw new Error('no database handle');
    const counts: Record<string, number> = {};
    for (const name of Object.keys(EXPECTED)) {
      counts[name] = await db.collection(name).countDocuments();
    }
    return counts;
  } finally {
    await conn.close();
  }
}

describe('npm run seed (integration, needs compose MongoDB)', () => {
  it('AT-21: runs twice with identical summaries and collection counts', async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI must be set for the integration test');
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync('npm', ['run', 'seed'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
      });
      expect(result.status, `run ${String(run + 1)} exit code`).toBe(0);
      const lines = result.stdout.trim().split('\n');
      const last = lines[lines.length - 1] ?? '';
      expect(SeedSummary.parse(JSON.parse(last))).toEqual(EXPECTED);
      expect(await collectionCounts(uri)).toEqual(EXPECTED);
    }
  }, 60_000);
});
