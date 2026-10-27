// specs/audit-view.md AT-13 (rule 12) and AT-14 (rule 13) against the pure toEvalHistory(files).
// files are the EvalResultsReader.list() entries: { name, read }.
import { describe, expect, it } from 'vitest';
import { EvalHistoryResponse } from './schemas.js';
import { toEvalHistory } from './eval-history.js';

type Read = { status: 'ok'; text: string } | { status: 'missing' } | { status: 'unreadable' };
interface File {
  name: string;
  read: Read;
}

const HEX64 = 'ab'.repeat(32);

function bucket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total: 40,
    passed: 37,
    failed: 2,
    errored: 1,
    skipped: 0,
    unscorable: 0,
    passRate: 0.925,
    threshold: 0.9,
    meetsThreshold: true,
    ...over,
  };
}

function runOf(
  agent: string,
  promptVersion: string,
  startedAt: string,
  over: {
    overall?: Record<string, unknown>;
    cases?: unknown[];
    summaryAgent?: string;
    runAgent?: string;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    startedAt,
    finishedAt: startedAt,
    gitCommit: null,
    thresholdsHash: HEX64,
    pricingHash: HEX64,
    agent: over.runAgent ?? agent,
    summary: {
      agent: over.summaryAgent ?? agent,
      model: 'claude-haiku-5-5',
      promptVersion,
      policyVersion: agent === 'orchestrator' ? null : 'v1',
      policyHash: agent === 'orchestrator' ? null : HEX64,
      overall: over.overall ?? bucket(),
      categories: {},
      tags: {},
      unreviewed: bucket({
        total: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        passRate: null,
        threshold: null,
        meetsThreshold: null,
      }),
      escalation: null,
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    },
    thresholdsMet: true,
    cases: over.cases ?? [],
  };
}

const ok = (name: string, run: unknown): File => ({
  name,
  read: { status: 'ok', text: JSON.stringify(run) },
});

describe('audit-view AT-13: each file is parsed as an EvalRun and only its summary is used', () => {
  const canaryCase = {
    agent: 'leave',
    id: 'EV-CANARY-1',
    category: 'routing',
    status: 'passed',
    reviewed: null,
    tags: [],
    asOf: null,
    skipReason: null,
    skipDetail: null,
    unscorableKeys: [],
    errorCode: null,
    checks: [],
    latencyMs: null,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
  };

  it('AT-13: one valid file becomes one point; bad files are skipped and counted; no case data leaks', () => {
    const r1 = runOf('leave', 'v2', '2026-10-20T09:00:00Z', { cases: [canaryCase] });
    const r2 = runOf('onboarding', 'v2', '2026-10-21T09:00:00Z');
    const files: File[] = [
      ok('2026-10-20-leave-v2.json', r1),
      ok('2026-10-21-leave-v2.json', {
        ...runOf('leave', 'v2', '2026-10-21T09:00:00Z'),
        schemaVersion: 1,
      }),
      { name: '2026-10-22-leave-v2.json', read: { status: 'ok', text: '{not json' } },
      ok('2026-10-23-leave-v2.json', r2), // the name says leave, the content says onboarding
      { name: '2026-10-24-leave-v2.json', read: { status: 'unreadable' } },
    ];
    const out = toEvalHistory(files);
    expect(EvalHistoryResponse.safeParse(out).success).toBe(true);
    expect(out.skippedFiles).toBe(4);
    expect(out.series).toHaveLength(1);
    expect(out.series[0]).toMatchObject({ agent: 'leave', promptVersion: 'v2' });
    expect(out.series[0]?.points).toHaveLength(1);
    expect(out.series[0]?.points[0]).toMatchObject({
      file: '2026-10-20-leave-v2.json',
      startedAt: '2026-10-20T09:00:00Z',
      model: 'claude-haiku-5-5',
      policyVersion: 'v1',
      passRate: 0.925,
      passed: 37,
      scored: 40,
      threshold: 0.9,
      thresholdsMet: true,
    });
    expect(JSON.stringify(out)).not.toContain('EV-CANARY-1');
  });

  it('AT-13: scored is passed + failed + errored + unscorable, and a null passRate stays null', () => {
    const overall = bucket({
      passed: 3,
      failed: 2,
      errored: 1,
      unscorable: 4,
      skipped: 9,
      passRate: null,
    });
    const out = toEvalHistory([
      ok('2026-10-20-leave-v2.json', runOf('leave', 'v2', '2026-10-20T09:00:00Z', { overall })),
    ]);
    const p = out.series[0]?.points[0];
    expect(p?.passRate).toBeNull();
    expect(p?.scored).toBe(10);
  });

  it('AT-13: a file whose summary.model is not a safe token, or lacks summary.overall, is skipped', () => {
    const badModel = runOf('leave', 'v2', '2026-10-20T09:00:00Z');
    (badModel.summary as Record<string, unknown>).model = '<b>x</b>';
    const noOverall = runOf('leave', 'v2', '2026-10-21T09:00:00Z');
    delete (noOverall.summary as Record<string, unknown>).overall;
    const out = toEvalHistory([
      ok('2026-10-20-leave-v2.json', badModel),
      ok('2026-10-21-leave-v2.json', noOverall),
    ]);
    expect(out).toEqual({ series: [], skippedFiles: 2 });
  });

  it('AT-13: a file whose summary.promptVersion is not a safe token is skipped, not a 500', () => {
    const out = toEvalHistory([
      ok('2026-10-20-leave-v2.json', runOf('leave', '<b>v 2</b>', '2026-10-20T09:00:00Z')),
      ok('2026-10-21-leave-v2.json', runOf('leave', 'v2', '2026-10-21T09:00:00Z')),
    ]);
    expect(EvalHistoryResponse.safeParse(out).success).toBe(true);
    expect(out.skippedFiles).toBe(1);
    expect(out.series.map((s) => s.promptVersion)).toEqual(['v2']);
  });
});

describe('audit-view AT-14: series are grouped and ordered in code', () => {
  const files: File[] = [
    ok('2026-10-22-leave-v2.json', runOf('leave', 'v2', '2026-10-22T09:00:00Z')),
    ok('2026-10-22-leave-v2-2.json', runOf('leave', 'v2', '2026-10-22T08:00:00-03:00')),
    ok('2026-10-15-leave-v1.json', runOf('leave', 'v1', '2026-10-15T09:00:00Z')),
    ok('2026-10-16-orchestrator-v1.json', runOf('orchestrator', 'v1', '2026-10-16T09:00:00Z')),
    ok('2026-10-17-policy_qa-v3.json', runOf('policy_qa', 'v3', '2026-10-17T09:00:00Z')),
  ];

  it('AT-14: series order is orchestrator v1, leave v1, leave v2, policy_qa v3; leave v2 is in startedAt order', () => {
    const out = toEvalHistory(files);
    expect(out.series.map((s) => `${s.agent} ${s.promptVersion}`)).toEqual([
      'orchestrator v1',
      'leave v1',
      'leave v2',
      'policy_qa v3',
    ]);
    expect(out.series[2]?.points.map((p) => p.file)).toEqual([
      '2026-10-22-leave-v2.json',
      '2026-10-22-leave-v2-2.json',
    ]);
  });

  it('AT-14: a shuffled reader order gives a deep-equal response', () => {
    expect(toEvalHistory([...files].reverse())).toEqual(toEvalHistory(files));
  });

  it('AT-14: a run at 2026-12-31T23:59:30Z is ordered by its startedAt instant, not its file date', () => {
    const out = toEvalHistory([
      ok('2026-12-31-leave-v2.json', runOf('leave', 'v2', '2027-01-01T00:10:00Z')),
      ok('2027-01-01-leave-v2.json', runOf('leave', 'v2', '2026-12-31T23:59:30Z')),
    ]);
    expect(out.series[0]?.points.map((p) => p.file)).toEqual([
      '2027-01-01-leave-v2.json',
      '2026-12-31-leave-v2.json',
    ]);
  });
});
