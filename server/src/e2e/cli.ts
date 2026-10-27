// The e2e server (spec e2e-demo, rules 4, 5, 7, 8 and 9). It seeds a fresh hr_e2e_<hex> database,
// then runs the production startServer with two swaps: model calls are replayed from
// e2e/recordings/ (or, owner only, recorded from the real model), and buildApp gets a frozen-date
// clock. start.ts is unchanged. Every dependency is injected; main.ts passes the real ones.
// Values are never printed: errors name the variable only.
import type { Express } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import type { ModelClient } from '../agents/schemas.js';
import { SeedEnv } from '../domain/schemas.js';
import type { MongoHandle } from '../persistence/mongo/connect.js';
import { fixtures } from '../seeds/fixtures.js';
import { mongoSeedWriter } from '../seeds/mongo-writer.js';
import { runSeed } from '../seeds/seed.js';
import type { ServerParts } from '../server/app.js';
import type { StartDeps } from '../server/start.js';
import { E2E_EPOCH_ISO, e2eClock } from './clock.js';
import { createRecordingModel } from './record-model.js';
import { createReplayModel } from './replay-model.js';

/** Replaces ANTHROPIC_API_KEY in replay mode, so no real key reaches the running server (rule 4). */
export const REPLAY_ONLY_KEY = 'replay-only';

const E2eEnv = z.object({
  E2E_MODEL: z.enum(['replay', 'record']).default('replay'),
  CI: z.string().optional(), // any non-empty value refuses record mode
  MONGODB_URI: SeedEnv.shape.MONGODB_URI,
  NODE_ENV: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(), // read only in record mode
}); // not strict: process.env holds unrelated variables

const E2eDbName = z.string().regex(/^hr_e2e_[0-9a-f]{12}$/);

type Env = Readonly<Record<string, string | undefined>>;

export interface E2eDeps {
  randomHex: () => string; // 12 lowercase hex characters
  seed: (uri: string) => Promise<number>;
  dropDatabase: (uri: string) => Promise<void>;
  createAnthropicClient: (env: Env) => ModelClient;
  runServerProcess: (deps: StartDeps) => Promise<number>;
  baseStartDeps: Omit<StartDeps, 'env' | 'createModel' | 'buildApp' | 'connect'>;
  connect: (uri: string) => Promise<MongoHandle>;
  buildApp: (parts: ServerParts) => Express;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  recordingsDir: string;
}

/** Same URI with its path replaced by /hr_e2e_<hex>; host, credentials and query are kept. */
export function deriveE2eUri(uri: string, hex: string): string {
  const u = new URL(uri);
  u.pathname = `/hr_e2e_${hex}`;
  return u.toString();
}

function dbNameOf(uri: string): string | null {
  try {
    return new URL(uri).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}

const isE2eDb = (uri: string): boolean => E2eDbName.safeParse(dbNameOf(uri)).success;

/** Wraps connect so closing the handle drops the database first, and only an hr_e2e_ one (rule 7). */
export function withGuardedDrop(
  connect: (uri: string) => Promise<MongoHandle>,
  dropDatabase: (uri: string) => Promise<void>,
): (uri: string) => Promise<MongoHandle> {
  return async (uri) => {
    const handle = await connect(uri);
    if (!isE2eDb(uri)) return handle;
    return {
      ...handle,
      close: async () => {
        try {
          await dropDatabase(uri);
        } finally {
          await handle.close();
        }
      },
    };
  };
}

function issueNames(issues: readonly { path: readonly PropertyKey[] }[]): string {
  return [...new Set(issues.map((i) => String(i.path[0])))].join(', ');
}

/** Resolves to the process exit code. */
export async function runE2e(rawEnv: Env, deps: E2eDeps): Promise<number> {
  const { stderr } = deps;
  const parsed = E2eEnv.safeParse(rawEnv);
  if (!parsed.success) {
    stderr(`e2e: invalid environment: ${issueNames(parsed.error.issues)}`);
    return 1;
  }
  const env = parsed.data;

  // Rule 8: refused before any connection, seed or listen.
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
    stderr('e2e: refused with NODE_ENV=production');
    return 1;
  }

  // Rule 5: recording spends credit, so it is owner-only and never runs in CI.
  const record = env.E2E_MODEL === 'record';
  if (record && env.CI !== undefined && env.CI !== '') {
    stderr('e2e: record mode is refused when CI is set');
    return 1;
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  if (record && apiKey === undefined) {
    stderr('e2e: record mode needs ANTHROPIC_API_KEY in .env');
    return 1;
  }

  // Rule 7: a fresh, isolated database per run.
  let uri: string;
  try {
    uri = deriveE2eUri(env.MONGODB_URI, deps.randomHex());
  } catch {
    stderr('e2e: MONGODB_URI is not a parseable URI');
    return 1;
  }
  if (!isE2eDb(uri)) {
    stderr('e2e: the derived database name is not hr_e2e_<12 hex>');
    return 1;
  }

  // One drop per run, shared: a forced stop starts it from the guarded close without awaiting it,
  // so the final await below waits for that same drop. The driver's message can echo the URI, so
  // a failure is reported by name only.
  let dropping: Promise<void> | null = null;
  const dropOnce = (target: string): Promise<void> =>
    (dropping ??= deps.dropDatabase(target).catch(() => {
      stderr('e2e: dropping the e2e database failed; remove the hr_e2e_* database by hand');
    }));

  if ((await deps.seed(uri)) !== 0) {
    await dropOnce(uri);
    return 1;
  }

  const clock = e2eClock(Date.parse(E2E_EPOCH_ISO));
  const createModel = (): ModelClient => {
    if (!record) return createReplayModel(deps.recordingsDir);
    return createRecordingModel(
      deps.createAnthropicClient({ ANTHROPIC_API_KEY: apiKey }),
      deps.recordingsDir,
    );
  };
  const code = await deps.runServerProcess({
    ...deps.baseStartDeps,
    env: {
      ...rawEnv,
      MONGODB_URI: uri,
      ANTHROPIC_API_KEY: record ? apiKey : REPLAY_ONLY_KEY,
    },
    createModel,
    connect: withGuardedDrop(deps.connect, dropOnce),
    buildApp: (parts) => deps.buildApp({ ...parts, clock }),
  });
  // A start that failed before connect never reached the guarded close.
  await dropOnce(uri);
  return code;
}

// ---- Real seed and drop, used by main.ts ----

export function seedE2eDatabase(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): (uri: string) => Promise<number> {
  return (uri) =>
    runSeed({ env: { MONGODB_URI: uri }, fixtures, writer: mongoSeedWriter, stdout, stderr });
}

/** Its own connection, so it works before, during or after the server's. Guarded by name. */
export async function dropE2eDatabase(uri: string): Promise<void> {
  if (!isE2eDb(uri)) return;
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await conn.asPromise();
    if (E2eDbName.safeParse(conn.name).success) await conn.dropDatabase();
  } finally {
    await conn.close();
  }
}
