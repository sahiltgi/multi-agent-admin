// specs/audit-view.md AT-12 (rule 11) and AT-17 (rule 16): the filesystem adapters, against a
// per-test temporary directory. Assumed constructors: new FsEvalResultsReader(evalResultsDir) and
// new FsDocReader({ devMetricsPath, aiLogPath }).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsDocReader, FsEvalResultsReader } from './fs-readers.js';

// AT-12: every path the reader opens, so a test can assert what was never opened.
const opened = vi.hoisted((): string[] => []);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      opened.push(String(args[0]));
      return actual.open(...args);
    },
  };
});

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'audit-view-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  opened.length = 0;
});

const MIB = 1024 * 1024;
/** Valid JSON of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const head = '{"pad":"';
  const tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
}

describe('audit-view AT-12: the results directory is fixed and every file is checked', () => {
  it('AT-12: five matching entries in name order (two ok, three unreadable); ignored names and the symlink target never appear', async () => {
    const root = tmp();
    const dir = join(root, 'results');
    mkdirSync(dir);
    writeFileSync(join(dir, '2026-10-20-leave-v2.json'), '{"valid":true}');
    writeFileSync(join(dir, '.gitkeep'), '');
    writeFileSync(join(dir, 'notes.txt'), 'NOTES-CANARY');
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'OUTSIDE-CANARY');
    symlinkSync(outside, join(dir, '2026-10-21-leave-v2.json'));
    mkdirSync(join(dir, '2026-10-22-leave-v2.json'));
    writeFileSync(join(dir, '2026-10-23-leave-v2.json'), jsonOfSize(MIB + 1));
    writeFileSync(join(dir, '2026-10-24-leave-v2.json'), jsonOfSize(MIB));

    const listed = await new FsEvalResultsReader(dir).list();
    expect(listed.map((e) => e.name)).toEqual([
      '2026-10-20-leave-v2.json',
      '2026-10-21-leave-v2.json',
      '2026-10-22-leave-v2.json',
      '2026-10-23-leave-v2.json',
      '2026-10-24-leave-v2.json',
    ]);
    expect(listed.map((e) => e.read.status)).toEqual([
      'ok',
      'unreadable',
      'unreadable',
      'unreadable',
      'ok',
    ]);
    const exact = listed[4]?.read;
    expect(exact?.status === 'ok' ? exact.text.length : -1).toBe(MIB);
    const serialised = JSON.stringify(listed);
    for (const never of [
      outside,
      join(dir, '2026-10-21-leave-v2.json'),
      join(dir, '2026-10-22-leave-v2.json'),
      join(dir, '2026-10-23-leave-v2.json'),
      join(dir, 'notes.txt'),
    ]) {
      expect(opened, never).not.toContain(never);
    }
    expect(opened).toContain(join(dir, '2026-10-20-leave-v2.json'));
    expect(serialised).not.toContain('OUTSIDE-CANARY');
    expect(serialised).not.toContain('NOTES-CANARY');
  });

  it('AT-12: a missing directory gives []', async () => {
    const missing = join(tmp(), 'no-such-dir');
    expect(await new FsEvalResultsReader(missing).list()).toEqual([]);
  });

  it('AT-12: a directory holding only .gitkeep gives []', async () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitkeep'), '');
    expect(await new FsEvalResultsReader(dir).list()).toEqual([]);
  });
});

describe('audit-view AT-17: two fixed files, read safely', () => {
  it('AT-17: a missing dev-metrics.md and a valid AI_LOG.md are reported separately', async () => {
    const dir = tmp();
    const aiLogPath = join(dir, 'AI_LOG.md');
    writeFileSync(aiLogPath, '| Date | Fix or rule added |\n| --- | --- |\n| 2026-10-01 | x |\n');
    const docs = new FsDocReader({ devMetricsPath: join(dir, 'dev-metrics.md'), aiLogPath });
    expect(await docs.devMetrics()).toEqual({ status: 'missing' });
    expect((await docs.aiLog()).status).toBe('ok');
  });

  it('AT-17: a symlinked AI_LOG.md is unreadable and its target is not returned', async () => {
    const dir = tmp();
    const target = join(dir, 'target.md');
    writeFileSync(target, 'TARGET-CANARY');
    const aiLogPath = join(dir, 'AI_LOG.md');
    symlinkSync(target, aiLogPath);
    const docs = new FsDocReader({ devMetricsPath: join(dir, 'dev-metrics.md'), aiLogPath });
    const r = await docs.aiLog();
    expect(r).toEqual({ status: 'unreadable' });
  });

  it('AT-17: a dev-metrics.md of 512 KiB + 1 byte is unreadable; exactly 512 KiB is ok', async () => {
    const dir = tmp();
    const devMetricsPath = join(dir, 'dev-metrics.md');
    writeFileSync(devMetricsPath, 'a'.repeat(512 * 1024 + 1));
    const docs = new FsDocReader({ devMetricsPath, aiLogPath: join(dir, 'AI_LOG.md') });
    expect(await docs.devMetrics()).toEqual({ status: 'unreadable' });
    writeFileSync(devMetricsPath, 'a'.repeat(512 * 1024));
    expect((await docs.devMetrics()).status).toBe('ok');
  });

  it('AT-17: bytes 0xff 0xfe are unreadable (not valid UTF-8)', async () => {
    const dir = tmp();
    const devMetricsPath = join(dir, 'dev-metrics.md');
    writeFileSync(devMetricsPath, Buffer.from([0xff, 0xfe]));
    const docs = new FsDocReader({ devMetricsPath, aiLogPath: join(dir, 'AI_LOG.md') });
    expect(await docs.devMetrics()).toEqual({ status: 'unreadable' });
  });
});
