import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Needs the compose MongoDB; run with `npm run test:integration`.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
  },
});
