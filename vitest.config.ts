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
    ],
  },
});
