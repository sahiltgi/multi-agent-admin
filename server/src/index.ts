// Server entry point. Loading the leave policy is the first startup step (spec leave-policy,
// rule 15): a malformed policy stops the server before anything else runs.
import { fileURLToPath } from 'node:url';
import { ServerEnv } from './domain/schemas.js';
import { PolicyLoadError, loadLeavePolicy } from './policies/load.js';

// Resolved from this module, not cwd: server/src and server/dist both sit two levels below the root.
const DEFAULT_LEAVE_POLICY = fileURLToPath(
  new URL('../../policies/leave/v1.yaml', import.meta.url),
);

function main(): number {
  const env = ServerEnv.safeParse(process.env);
  if (!env.success) {
    const names = env.error.issues.map((i) => i.path.map(String).join('.')).join(', ');
    process.stderr.write(`Invalid server environment: ${names}\n`);
    return 1;
  }
  let leavePolicy;
  try {
    leavePolicy = loadLeavePolicy(env.data.LEAVE_POLICY_PATH ?? DEFAULT_LEAVE_POLICY);
  } catch (e) {
    if (!(e instanceof PolicyLoadError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  console.log(
    `leave policy ${leavePolicy.policyVersion} loaded (sha256 ${leavePolicy.policyHash})`,
  );
  // Later startup steps go here; this line marks that startup got past the policy check.
  console.log('startup: ready');
  return 0;
}

process.exitCode = main();
