// Integration tests that need the compose MongoDB. Run with `npm run test:integration`,
// which loads `.env`. Kept out of `npm test` by the exclude in vitest.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'server-integration',
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
  },
});
