import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'server',
      'web',
      {
        test: {
          name: 'hooks',
          environment: 'node',
          include: ['.claude/hooks/**/*.test.ts'],
        },
      },
      {
        // spec dev-metrics, rule 2: repo tooling under scripts/
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
