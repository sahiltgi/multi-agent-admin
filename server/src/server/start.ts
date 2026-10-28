// Process startup and shutdown (spec mongo-persistence, rules 9–14; D-3 to D-11, D-18). Every
// step is injected, so the order, the refusals and the shutdown are unit-tested without MongoDB.
// Each printed error is scrubbed of the URI, its credentials and the API key (rule 14).
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import type { ModelClient } from '../agents/schemas.js';
import { resolveModelId, selectProvider } from '../agents/model-provider.js';
import { NO_MODEL_KEY_MESSAGE, ServerEnv, ServerRuntimeEnv } from '../domain/schemas.js';
import type { LoadedLeavePolicy } from '../gate/leave-policy.schema.js';
import { assertDemoIdentityAllowed } from '../http/identity.js';
import { createScrubber, secretsOfUri } from '../lib/secrets.js';
import type { MongoHandle } from '../persistence/mongo/connect.js';
import { PolicyLoadError } from '../policies/load.js';
import type { ServerParts } from './app.js';
import { SHIPPED_AGENT_CONFIGS, unmappedModels, unpricedModels, type BootFiles } from './boot.js';
import type { ListeningServer } from './http.js';
import { systemClock, timerScheduler, uuidIdGen } from './runtime.js';

export type Signal = 'SIGTERM' | 'SIGINT';

export const CHECK_POLICY_FLAG = '--check-policy';
export const BIND_HOST = '127.0.0.1'; // D-5: local or private host only (ADR-0005)

export interface StartDeps {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  loadPolicy: (path: string) => LoadedLeavePolicy;
  loadBootFiles: (promptsRoot: string) => Promise<BootFiles>;
  createModel: (env: ServerRuntimeEnv) => ModelClient;
  connect: (uri: string) => Promise<MongoHandle>;
  buildApp: (parts: ServerParts) => Express;
  listen: (app: Express, port: number, host: string) => Promise<ListeningServer>;
  onSignal: (signal: Signal, handler: () => void) => void;
  graceMs: number;
}

// Resolved from this module, not cwd: server/src/server and server/dist/server are both three
// levels below the repo root.
const DEFAULT_LEAVE_POLICY = fileURLToPath(
  new URL('../../../policies/leave/v1.yaml', import.meta.url),
);
const PROMPTS_ROOT = fileURLToPath(new URL('../../../prompts', import.meta.url));

/** Variable names only, never values (rule 9). */
function issueNames(issues: readonly { path: readonly PropertyKey[] }[]): string {
  return [...new Set(issues.map((i) => String(i.path[0])))].join(', ');
}

function hasModelKey(env: unknown): boolean {
  try {
    selectProvider(env);
    return true;
  } catch {
    return false;
  }
}

/** Variable names, plus the fixed no-key message when neither model key is set (gemini-fallback, rule 3). */
function runtimeEnvProblem(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  env: unknown,
): string {
  const others = issues.filter((i) => i.message !== NO_MODEL_KEY_MESSAGE);
  // Checked directly too: Zod skips the schema's key refinement when another field already failed.
  const noKey = others.length < issues.length || !hasModelKey(env);
  return [
    ...(others.length > 0 ? [issueNames(others)] : []),
    ...(noKey ? [NO_MODEL_KEY_MESSAGE] : []),
  ].join('; ');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/** D-3: logs the orphan count only; a failed count is reported and never blocks startup. */
async function reportOrphans(
  mongo: MongoHandle,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<void> {
  try {
    const orphans = await mongo.countOrphans();
    if (orphans > 0) {
      stdout(`startup: ${String(orphans)} intake requests have no approval item (D-3)`);
    }
  } catch (err) {
    stderr(`startup: counting orphaned intake requests failed: ${messageOf(err)}`);
  }
}

/** Resolves to the process exit code: at once on failure or --check-policy, else after shutdown. */
export async function startServer(deps: StartDeps): Promise<number> {
  const { stdout, stderr } = deps;

  // 1. The leave policy loads first (leave-policy rule 15), reading only LEAVE_POLICY_PATH.
  const policyEnv = ServerEnv.safeParse(deps.env);
  if (!policyEnv.success) {
    stderr(`Invalid server environment: ${issueNames(policyEnv.error.issues)}`);
    return 1;
  }
  let policy: LoadedLeavePolicy;
  try {
    policy = deps.loadPolicy(policyEnv.data.LEAVE_POLICY_PATH ?? DEFAULT_LEAVE_POLICY);
  } catch (err) {
    stderr(err instanceof PolicyLoadError ? err.message : 'Leave policy failed to load');
    return 1;
  }
  stdout(`leave policy ${policy.policyVersion} loaded (sha256 ${policy.policyHash})`);
  if (deps.argv.includes(CHECK_POLICY_FLAG)) {
    stdout('startup: ready'); // D-11: the policy check stops here
    return 0;
  }

  // 2. The rest of the env (rule 9).
  const parsed = ServerRuntimeEnv.safeParse(deps.env);
  if (!parsed.success) {
    stderr(`Invalid server environment: ${runtimeEnvProblem(parsed.error.issues, deps.env)}`);
    return 1;
  }
  const env = parsed.data;
  // Every present model key is scrubbed, whichever provider runs (gemini-fallback, rule 3).
  const keys = [env.ANTHROPIC_API_KEY, env.GEMINI_API_KEY].filter((k) => k !== undefined);
  const scrub = createScrubber([...secretsOfUri(env.MONGODB_URI), ...keys]);
  const provider = selectProvider(env);

  // 3. Refuse production before any connection, app or port (rule 11).
  try {
    assertDemoIdentityAllowed(env.NODE_ENV);
  } catch (err) {
    stderr(scrub(messageOf(err)));
    return 1;
  }

  // 4–5. Prompt files, then the model client.
  let boot: BootFiles;
  let model: ModelClient;
  try {
    boot = await deps.loadBootFiles(PROMPTS_ROOT);
  } catch (err) {
    stderr(scrub(`startup: prompt files failed: ${messageOf(err)}`));
    return 1;
  }
  // gemini-fallback, rule 6: every shipped model must map on Gemini, and pricing is checked on the
  // ids actually called.
  const unmapped = unmappedModels(provider, SHIPPED_AGENT_CONFIGS);
  if (unmapped.length > 0) {
    for (const { model: m, agentId } of unmapped) {
      stderr(scrub(`startup: no gemini model mapped for ${m} (agent ${agentId})`));
    }
    return 1;
  }
  const resolved = SHIPPED_AGENT_CONFIGS.map((c) => ({
    ...c,
    model: resolveModelId(provider, c.model),
  }));
  // spec agent-metrics, rule 4: a running server never meets an unpriced shipped model.
  const unpriced = unpricedModels(boot.pricing, resolved);
  if (unpriced.length > 0) {
    for (const { model: m, agentId } of unpriced) {
      stderr(scrub(`startup: pricing has no entry for model ${m} (agent ${agentId})`));
    }
    return 1;
  }
  try {
    model = deps.createModel(env);
  } catch (err) {
    stderr(scrub(`startup: model client failed: ${messageOf(err)}`));
    return 1;
  }

  // 6. MongoDB, with every index in place (D-4), then the orphan count (D-3).
  let mongo: MongoHandle;
  try {
    mongo = await deps.connect(env.MONGODB_URI);
  } catch (err) {
    stderr(scrub(`startup: MongoDB connection failed: ${messageOf(err)}`));
    return 1;
  }
  const closeMongo = async (): Promise<void> => {
    try {
      await mongo.close();
    } catch (err) {
      stderr(scrub(`shutdown: closing MongoDB failed: ${messageOf(err)}`));
    }
  };

  // 7–8. App, then listen.
  let listening: ListeningServer;
  try {
    await reportOrphans(mongo, stdout, (line) => {
      stderr(scrub(line));
    });
    const app = deps.buildApp({
      policy,
      boot,
      stores: mongo.stores,
      model,
      clock: systemClock,
      scheduler: timerScheduler,
      idGen: uuidIdGen,
    });
    listening = await deps.listen(app, env.PORT, BIND_HOST);
  } catch (err) {
    stderr(scrub(`startup: failed: ${messageOf(err)}`));
    await closeMongo();
    return 1;
  }

  // Graceful shutdown (rule 13): stop accepting, let in-flight requests finish within the
  // grace period, close MongoDB, exit 0. A second signal or an expired grace period exits 1.
  return new Promise<number>((resolve) => {
    let stopping = false;
    let settled = false;
    let cancelGrace: () => void = () => undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      cancelGrace();
      if (code !== 0) {
        // Forced stop: exit without waiting, even for a stalled MongoDB close (rule 13).
        void closeMongo();
        resolve(code);
        return;
      }
      void closeMongo().then(() => {
        resolve(code);
      });
    };
    const forceStop = (): void => {
      listening.forceClose();
      finish(1);
    };
    const onSignal = (): void => {
      if (stopping) {
        forceStop();
        return;
      }
      stopping = true;
      cancelGrace = timerScheduler.setTimeout(forceStop, deps.graceMs);
      listening.close().then(
        () => {
          finish(0);
        },
        (err: unknown) => {
          stderr(scrub(`shutdown: closing the HTTP server failed: ${messageOf(err)}`));
          forceStop();
        },
      );
    };
    deps.onSignal('SIGTERM', onSignal);
    deps.onSignal('SIGINT', onSignal);
    stdout('startup: ready');
  });
}

/**
 * Process entry (rule 13): a failed start or a forced stop (second signal, expired grace period)
 * exits at once with its non-zero code, without waiting for open handles such as an in-flight
 * model call or a runtime timer. A clean shutdown returns its code and lets the process end.
 */
export async function runServerProcess(
  deps: StartDeps,
  exit: (code: number) => void,
): Promise<number> {
  const code = await startServer(deps);
  if (code !== 0) exit(code);
  return code;
}
