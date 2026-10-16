// Server entry point (spec mongo-persistence, rule 10; D-11). Loading the leave policy is still the
// first startup step (spec leave-policy, rule 15). `--check-policy` stops after it.
// `.env` is loaded by Node's --env-file-if-exists flag in `npm start`; values are never printed.
import { createAnthropicClient } from './agents/anthropic-client.js';
import { connectMongo } from './persistence/mongo/connect.js';
import { loadLeavePolicy } from './policies/load.js';
import { buildApp } from './server/app.js';
import { loadBootFiles } from './server/boot.js';
import { listenHttp } from './server/http.js';
import { runServerProcess } from './server/start.js';

// D-8: one 90-second Leave Agent run plus margin.
const SHUTDOWN_GRACE_MS = 95_000;

process.exitCode = await runServerProcess(
  {
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
    loadPolicy: loadLeavePolicy,
    loadBootFiles,
    createModel: createAnthropicClient,
    connect: connectMongo,
    buildApp,
    listen: listenHttp,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    graceMs: SHUTDOWN_GRACE_MS,
  },
  (code) => {
    process.exit(code);
  },
);
