// Seed runner (spec domain-schemas, rules 13–15). Validates the env and every fixture before
// any database call, then replaces each seeded collection. Never prints the connection URI.
import { z } from 'zod';
import {
  Employee,
  Holiday,
  LeaveBalance,
  LeaveRequest,
  SeedEnv,
  Team,
  type SeedSummary,
} from '../domain/schemas.js';
import type { SeedFixtures } from './fixtures.js';
import { createScrubber, secretsOfUri } from '../lib/secrets.js';
import { checkSeedInvariants } from './invariants.js';

export const SEED_COLLECTIONS = [
  'teams',
  'employees',
  'leaveBalances',
  'holidays',
  'leaveRequests',
] as const;
export type SeedCollection = (typeof SEED_COLLECTIONS)[number];

/** Collections that point at seeded requests; cleared so a reseed leaves no orphans (D-15). */
export const SEED_CLEARED = [
  'approvalItems',
  'messageOwners',
  'idempotencyRecords',
  'conversations', // chat-endpoint D-7: card snapshots would point at deleted requests
  'policyQuestions', // spec policy-qa, rule 26: their escalation items are cleared too
] as const;
export type SeedClearedCollection = (typeof SEED_CLEARED)[number];

export interface SeedWriter {
  connect(uri: string): Promise<void>;
  /** Empties a collection the seed doesn't fill. Audit events are never cleared (append-only). */
  clear(collection: SeedClearedCollection): Promise<void>;
  replaceAll(collection: SeedCollection, docs: readonly unknown[]): Promise<void>;
  disconnect(): Promise<void>;
}

export interface SeedDeps {
  env: Readonly<Record<string, string | undefined>>;
  fixtures: Readonly<Record<SeedCollection, readonly unknown[]>>;
  writer: SeedWriter;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const RERUN_HINT = 'The database may be partly seeded. Fix the cause and re-run `npm run seed`.';

/** Parses every raw fixture record, collecting readable errors instead of throwing. */
function parseFixtures(
  raw: SeedDeps['fixtures'],
): { fixtures: SeedFixtures } | { errors: string[] } {
  const errors: string[] = [];
  function parseAll<T>(collection: SeedCollection, schema: z.ZodType<T>): T[] {
    const parsed: T[] = [];
    raw[collection].forEach((record, index) => {
      const result = schema.safeParse(record);
      if (result.success) {
        parsed.push(result.data);
        return;
      }
      for (const issue of result.error.issues) {
        errors.push(`${collection}[${String(index)}].${issue.path.join('.')}: ${issue.message}`);
      }
    });
    return parsed;
  }
  const fixtures: SeedFixtures = {
    teams: parseAll('teams', Team),
    employees: parseAll('employees', Employee),
    leaveBalances: parseAll('leaveBalances', LeaveBalance),
    holidays: parseAll('holidays', Holiday),
    leaveRequests: parseAll('leaveRequests', LeaveRequest),
  };
  return errors.length > 0 ? { errors } : { fixtures };
}

function scrubber(uri: string): (text: string) => string {
  return createScrubber(secretsOfUri(uri));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/** Runs the seed and resolves to the process exit code. Never throws. */
export async function runSeed(deps: SeedDeps): Promise<number> {
  const { writer, stdout, stderr } = deps;

  const env = SeedEnv.safeParse(deps.env);
  if (!env.success) {
    const names = [...new Set(env.error.issues.map((i) => String(i.path[0])))].join(', ');
    stderr(
      `seed: ${names} is missing or invalid. Set MONGODB_URI in .env to a mongodb:// URI (see .env.example).`,
    );
    return 1;
  }
  const scrub = scrubber(env.data.MONGODB_URI);

  if (env.data.NODE_ENV === 'production') {
    stderr(
      'seed: refusing to run with NODE_ENV=production. The seed deletes and reinserts demo data.',
    );
    return 1;
  }

  const parsed = parseFixtures(deps.fixtures);
  if ('errors' in parsed) {
    stderr('seed: fixtures failed validation; nothing was written.');
    for (const e of parsed.errors) stderr(`  ${e}`);
    return 1;
  }
  const violations = checkSeedInvariants(parsed.fixtures);
  if (violations.length > 0) {
    stderr('seed: fixtures break the seed invariants; nothing was written.');
    for (const v of violations) stderr(`  ${v}`);
    return 1;
  }

  let exitCode = 0;
  try {
    await writer.connect(env.data.MONGODB_URI);
  } catch (err) {
    stderr(scrub(`seed: could not connect to MongoDB: ${describeError(err)}`));
    exitCode = 1;
  }

  if (exitCode === 0) {
    for (const collection of SEED_CLEARED) {
      try {
        await writer.clear(collection);
      } catch (err) {
        stderr(scrub(`seed: clearing ${collection} failed: ${describeError(err)}. ${RERUN_HINT}`));
        exitCode = 1;
        break;
      }
    }
  }

  if (exitCode === 0) {
    for (const collection of SEED_COLLECTIONS) {
      try {
        await writer.replaceAll(collection, parsed.fixtures[collection]);
      } catch (err) {
        stderr(scrub(`seed: writing ${collection} failed: ${describeError(err)}. ${RERUN_HINT}`));
        exitCode = 1;
        break;
      }
    }
  }

  try {
    await writer.disconnect();
  } catch (err) {
    stderr(scrub(`seed: disconnect failed: ${describeError(err)}`));
  }
  if (exitCode !== 0) return exitCode;

  const summary: SeedSummary = {
    teams: parsed.fixtures.teams.length,
    employees: parsed.fixtures.employees.length,
    leaveBalances: parsed.fixtures.leaveBalances.length,
    holidays: parsed.fixtures.holidays.length,
    leaveRequests: parsed.fixtures.leaveRequests.length,
  };
  stdout(JSON.stringify(summary));
  return 0;
}
