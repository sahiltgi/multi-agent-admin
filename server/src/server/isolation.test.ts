// AT-19, unit half (specs/mongo-persistence.md rule 15): integration tests stay out of `npm test`
// and no unit test opens a MongoDB connection.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = join(import.meta.dirname, '..', '..');
const SRC_ROOT = join(SERVER_ROOT, 'src');
const SELF = 'isolation.test.ts';

// Built from fragments so this file never matches its own scan.
// Only an import (or dynamic import) of the helper counts; a source-text scan that names it is fine.
const CONNECT_HELPER = new RegExp(`import\\b[^;]*\\bconnectMongo\\b[^;]*from|connectMongo\\s*\\(`);
const DRIVER_CONNECT = new RegExp(`mongoose\\s*\\.\\s*connect\\s*\\(`);

function unitTestFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.test\.tsx?$/.test(f) && !/\.integration\.test\.tsx?$/.test(f))
    .filter((f) => !f.endsWith(SELF))
    .map((f) => join(SRC_ROOT, f));
}

describe('test isolation', () => {
  it('AT-19: the server vitest config excludes integration tests from npm test', () => {
    const config = readFileSync(join(SERVER_ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/exclude:[^\]]*src\/\*\*\/\*\.integration\.test\.ts/);
    expect(config).not.toMatch(/include:[^\]]*integration/);
  });

  it('AT-19: no unit test file imports connectMongo or calls mongoose.connect', () => {
    const files = unitTestFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(CONNECT_HELPER);
      expect(src, f).not.toMatch(DRIVER_CONNECT);
    }
  });
});
