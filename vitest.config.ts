import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'server',
      'web',
      {
        // spec web-shell, rule 18: the @hr/shared facade
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/src/**/*.test.ts'],
        },
      },
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
