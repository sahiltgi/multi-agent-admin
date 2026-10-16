import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { SeedSummary } from '../domain/schemas.js';

// A TypeError from `new URL` carries the input (the URI) and would be printed; throw a plain one.
function parseUriQuietly(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new Error('MONGODB_URI is not a single-host URI this test can isolate (value not shown)');
  }
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const EXPECTED = { teams: 3, employees: 20, leaveBalances: 120, holidays: 6, leaveRequests: 5 };

// Isolated database (spec mongo-persistence rule 15, D-9): only the URI path changes, so the
// seeded dev database is never written. The URI is never printed.
function isolatedUri(uri: string): string {
  const u = parseUriQuietly(uri);
  u.pathname = `/hr_test_${randomBytes(6).toString('hex')}`;
  return u.toString();
}

async function dropTestDatabase(uri: string): Promise<void> {
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    if (conn.name.startsWith('hr_test_')) await conn.dropDatabase();
  } finally {
    await conn.close();
  }
}

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
    const devUri = process.env.MONGODB_URI;
    if (!devUri) throw new Error('MONGODB_URI must be set for the integration test');
    const uri = isolatedUri(devUri);
    try {
      for (let run = 0; run < 2; run += 1) {
        const result = spawnSync('npm', ['run', 'seed'], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, MONGODB_URI: uri },
        });
        expect(result.status, `run ${String(run + 1)} exit code`).toBe(0);
        const lines = result.stdout.trim().split('\n');
        const last = lines[lines.length - 1] ?? '';
        expect(SeedSummary.parse(JSON.parse(last))).toEqual(EXPECTED);
        expect(await collectionCounts(uri)).toEqual(EXPECTED);
      }
    } finally {
      await dropTestDatabase(uri);
    }
  }, 120_000);
});
