import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TIMEOUT = 20000;

const VALID = `version: v1
effectiveFrom: '2026-10-01'
leaveTypes: [annual, sick, casual, unpaid, bereavement, parental]
minNoticeWorkingDays: { annual: 5, sick: 0, casual: 1, unpaid: 10, bereavement: 0, parental: 20 }
requiredFields:
  annual: [startDate, endDate]
  sick: [startDate, endDate]
  casual: [startDate, endDate]
  unpaid: [startDate, endDate, reason]
  bereavement: [startDate, endDate]
  parental: [startDate, endDate]
alwaysEscalate: [unpaid, bereavement, parental]
blackoutWindows:
  - { id: bw-year-end, start: '2026-12-21', end: '2026-12-31', label: Year-end close }
maxTeamOverlapPercent: 30
escalateAboveConsecutiveWorkingDays: 10
`;

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'leave-policy-boot-'));
  const file = join(dir, 'v1.yaml');
  writeFileSync(file, content);
  return file;
}

function runServer(policyPath?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LEAVE_POLICY_PATH;
  if (policyPath !== undefined) env.LEAVE_POLICY_PATH = policyPath;
  const r = spawnSync('node', ['--import', 'tsx', 'server/src/index.ts', '--check-policy'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 15000,
    killSignal: 'SIGKILL',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('shutdown grace (chat-endpoint)', () => {
  it('AT-31: the production shutdown grace passed to the server process is 160,000 ms', () => {
    const src = readFileSync(join(REPO_ROOT, 'server', 'src', 'index.ts'), 'utf8');
    expect(src).toMatch(/SHUTDOWN_GRACE_MS\s*=\s*160_?000\b/);
    expect(src).toMatch(/graceMs:\s*SHUTDOWN_GRACE_MS/);
  });
});

describe('server startup policy loading', () => {
  it(
    'AT-23: broken YAML exits 1, names file and line, and runs no later step',
    () => {
      const file = fixture('version: v1\nleaveTypes: [annual, sick\nmaxTeamOverlapPercent: 30\n');
      const r = runServer(file);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(file);
      expect(r.stderr).toMatch(/line\s*\d+|:\d+/i);
      expect(r.stdout).not.toContain('startup: ready');
    },
    TIMEOUT,
  );

  it(
    'AT-24: schema failure names the path; committed v1 logs version and hash once',
    () => {
      const file = fixture(
        VALID.replace('maxTeamOverlapPercent: 30', 'maxTeamOverlapPercent: 0.3'),
      );
      const bad = runServer(file);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(file);
      expect(bad.stderr).toContain('maxTeamOverlapPercent');
      expect(bad.stdout).not.toContain('startup: ready');

      const ok = runServer();
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('startup: ready');
      const lines = ok.stdout.split('\n').filter((l) => /[a-f0-9]{64}/.test(l) && l.includes('v1'));
      expect(lines).toHaveLength(1);
      const hashes = ok.stdout.match(/[a-f0-9]{64}/g) ?? [];
      expect(hashes).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'D-4: an invalid LEAVE_POLICY_PATH exits 1 with one readable error, not a stack trace',
    () => {
      const r = runServer('');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('LEAVE_POLICY_PATH');
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(r.stdout).not.toContain('startup: ready');
    },
    TIMEOUT,
  );
});
