// Playwright config for the demo e2e suite (spec e2e-demo, rule 10). One worker, Chromium only,
// and two servers started fresh for every run: the e2e API (replayed model, seeded hr_e2e_* DB) on
// 3100 and Vite on 5174 proxying /api to it. reuseExistingServer is off, so a dev server running
// the real Anthropic client is never picked up.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0, // deterministic by design: a flaky step is a bug, not a retry
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run e2e:server',
      // Any route answers once the server listens; 401 without x-demo-user counts as ready.
      url: 'http://127.0.0.1:3100/approvals',
      // Set here so they win over .env (--env-file never overrides a set variable): only the shell
      // turns on record mode (`npm run e2e:record`), and a shell NODE_ENV=production still reaches
      // the server's refusal.
      env: {
        PORT: '3100',
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        E2E_MODEL: process.env.E2E_MODEL ?? 'replay',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -w web -- --host 127.0.0.1 --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      env: { API_PROXY_TARGET: 'http://127.0.0.1:3100' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
