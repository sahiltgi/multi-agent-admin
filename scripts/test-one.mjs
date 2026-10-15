// Runs a single Vitest file: `npm run test:one -- path/to/file.test.ts`.
// Exits 2 when the argument is missing or the file does not exist, so a typo
// never silently falls back to running the whole suite.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const file = process.argv[2];

if (file === undefined || process.argv.length > 3) {
  console.error('Usage: npm run test:one -- <path/to/file.test.ts>');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`test:one: file not found: ${file}`);
  process.exit(2);
}

const result = spawnSync('npx', ['vitest', 'run', file], { stdio: 'inherit' });
process.exit(result.status ?? 1);
