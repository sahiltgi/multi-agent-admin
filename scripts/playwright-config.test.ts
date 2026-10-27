// Spec e2e-demo, rule 10 (AT-23). The root Playwright config pins the isolated, serial e2e setup.
import { describe, expect, it } from 'vitest';
import config from '../playwright.config.js';

interface WebServerShape {
  command: string;
  port?: number;
  url?: string;
  reuseExistingServer?: boolean;
  env?: Record<string, string>;
  gracefulShutdown?: { signal: string; timeout: number };
}
interface ConfigShape {
  testDir?: string;
  testMatch?: string;
  workers?: number;
  fullyParallel?: boolean;
  use?: { baseURL?: string };
  projects?: { name?: string; use?: { browserName?: string; defaultBrowserType?: string } }[];
  webServer?: WebServerShape | WebServerShape[];
}

const cfg = config as unknown as ConfigShape;
const servers = (): WebServerShape[] =>
  Array.isArray(cfg.webServer) ? cfg.webServer : cfg.webServer ? [cfg.webServer] : [];

describe('playwright.config.ts', () => {
  it('AT-23: serial, e2e-only, fixed base URL', () => {
    expect(cfg.workers).toBe(1);
    expect(cfg.fullyParallel).toBe(false);
    expect(cfg.testDir).toBe('e2e');
    expect(cfg.testMatch).toBe('*.e2e.ts');
    expect(cfg.use?.baseURL).toBe('http://127.0.0.1:5174');
  });

  it('AT-23: exactly two web servers, neither reuses an existing server', () => {
    expect(servers()).toHaveLength(2);
    for (const s of servers()) expect(s.reuseExistingServer).toBe(false);
  });

  it('AT-23: the API entry uses PORT 3100 and SIGTERM shutdown', () => {
    const api = servers().find((s) => s.command.includes('e2e:server'));
    expect(api).toBeDefined();
    expect(api?.env?.PORT).toBe('3100');
    expect(api?.gracefulShutdown?.signal).toBe('SIGTERM');
  });

  it('AT-23: NODE_ENV and E2E_MODEL come from the shell only, so .env cannot switch them', () => {
    const api = servers().find((s) => s.command.includes('e2e:server'));
    // Set in the webServer env, they win over .env (--env-file never overrides a set variable).
    expect(api?.env?.NODE_ENV).toBe(process.env.NODE_ENV ?? 'test');
    expect(api?.env?.E2E_MODEL).toBe(process.env.E2E_MODEL ?? 'replay');
  });

  it('AT-23: the web entry proxies to 3100 and fails rather than drifting ports', () => {
    const web = servers().find((s) => s.command.includes('dev -w web'));
    expect(web).toBeDefined();
    expect(web?.env?.API_PROXY_TARGET).toBe('http://127.0.0.1:3100');
    expect(web?.command).toContain('--strictPort');
    expect(web?.command).toContain('--port 5174');
  });

  it('AT-23: only a Chromium project', () => {
    const projects = cfg.projects ?? [];
    expect(projects).toHaveLength(1);
    const p = projects[0];
    expect(`${p?.name ?? ''} ${p?.use?.defaultBrowserType ?? ''}`.toLowerCase()).toContain(
      'chromium',
    );
  });
});
