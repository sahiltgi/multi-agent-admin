// Entry point for `npm run e2e:server` (spec e2e-demo, rule 9), started by playwright.config.ts.
// `.env` is loaded by Node's --env-file-if-exists flag; values are never printed.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAnthropicClient } from '../agents/anthropic-client.js';
import { connectMongo } from '../persistence/mongo/connect.js';
import { loadLeavePolicy } from '../policies/load.js';
import { buildApp } from '../server/app.js';
import { loadBootFiles } from '../server/boot.js';
import { listenHttp } from '../server/http.js';
import { startServer } from '../server/start.js';
import { dropE2eDatabase, runE2e, seedE2eDatabase } from './cli.js';

const RECORDINGS_DIR = fileURLToPath(new URL('../../../e2e/recordings', import.meta.url));
const SHUTDOWN_GRACE_MS = 10_000; // Playwright stops the server once the suite is done

const stdout = (line: string): void => {
  console.log(line);
};
const stderr = (line: string): void => {
  console.error(line);
};

// Rule 4: in replay mode the real key leaves the process, not just the env copy runE2e passes on.
const env = { ...process.env };
if (env.E2E_MODEL !== 'record') delete process.env.ANTHROPIC_API_KEY;

// startServer, not runServerProcess: the latter exits on a failed or forced stop, which would skip
// runE2e's drop of the hr_e2e_* database (rule 7). The exit below still ends the process at once.
const code = await runE2e(env, {
  randomHex: () => randomBytes(6).toString('hex'),
  seed: seedE2eDatabase(stdout, stderr),
  dropDatabase: dropE2eDatabase,
  createAnthropicClient,
  runServerProcess: startServer,
  baseStartDeps: {
    argv: process.argv.slice(2),
    stdout,
    stderr,
    loadPolicy: loadLeavePolicy,
    loadBootFiles,
    listen: listenHttp,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    graceMs: SHUTDOWN_GRACE_MS,
  },
  connect: connectMongo,
  buildApp,
  stdout,
  stderr,
  recordingsDir: RECORDINGS_DIR,
});
// Open handles (an in-flight replay, a runtime timer) must not keep a stopped server alive.
process.exit(code);
