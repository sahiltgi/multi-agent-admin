import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BlackoutWindow,
  LeavePolicyV1,
  LoadedLeavePolicy,
  PolicyHash,
  REQUIRED_FIELD_NAMES,
} from './leave-policy.schema.js';

type Json = Record<string, unknown>;

const V1: Json = {
  version: 'v1',
  effectiveFrom: '2026-10-01',
  leaveTypes: ['annual', 'sick', 'casual', 'unpaid', 'bereavement', 'parental'],
  minNoticeWorkingDays: {
    annual: 5,
    sick: 0,
    casual: 1,
    unpaid: 10,
    bereavement: 0,
    parental: 20,
  },
  requiredFields: {
    annual: ['startDate', 'endDate'],
    sick: ['startDate', 'endDate'],
    casual: ['startDate', 'endDate'],
    unpaid: ['startDate', 'endDate', 'reason'],
    bereavement: ['startDate', 'endDate'],
    parental: ['startDate', 'endDate'],
  },
  alwaysEscalate: ['unpaid', 'bereavement', 'parental'],
  blackoutWindows: [
    { id: 'bw-year-end', start: '2026-12-21', end: '2026-12-31', label: 'Year-end close' },
  ],
  maxTeamOverlapPercent: 30,
  escalateAboveConsecutiveWorkingDays: 10,
};

function clone(mutate?: (o: Json) => void): unknown {
  const o = structuredClone(V1);
  mutate?.(o);
  return o;
}

function asRec(v: unknown): Json {
  return v as Json;
}

function issuePaths(input: unknown): (string | number)[][] | null {
  const r = LeavePolicyV1.safeParse(input);
  return r.success ? null : r.error.issues.map((i) => [...i.path] as (string | number)[]);
}

function failsAtPrefix(input: unknown, prefix: (string | number)[]): boolean {
  const paths = issuePaths(input);
  if (paths === null) return false;
  return paths.some((p) => prefix.every((seg, idx) => p[idx] === seg));
}

function failsAtExact(input: unknown, exact: (string | number)[]): boolean {
  const paths = issuePaths(input);
  if (paths === null) return false;
  return paths.some((p) => JSON.stringify(p) === JSON.stringify(exact));
}

const passes = (input: unknown): boolean => LeavePolicyV1.safeParse(input).success;

describe('leave policy schema', () => {
  it('AT-1: schema accepts the agreed v1 values', () => {
    expect(passes(clone())).toBe(true);
    expect(REQUIRED_FIELD_NAMES).toEqual(['startDate', 'endDate', 'reason']);
  });

  it('AT-1: removing any of the 9 top-level keys, or a blackout label, fails', () => {
    expect(Object.keys(V1)).toHaveLength(9);
    for (const key of Object.keys(V1)) {
      const withoutKey = Object.fromEntries(Object.entries(V1).filter(([k]) => k !== key));
      expect(failsAtExact(withoutKey, [key]), key).toBe(true);
    }
    expect(
      failsAtExact(
        clone((o) => {
          delete asRec((o.blackoutWindows as unknown[])[0]).label;
        }),
        ['blackoutWindows', 0, 'label'],
      ),
    ).toBe(true);
  });

  it('AT-3: unknown keys are rejected at top level and in a blackout window', () => {
    expect(
      failsAtExact(
        clone((o) => (o.autoApprove = true)),
        [],
      ),
    ).toBe(true);
    expect(
      failsAtExact(
        clone((o) => {
          asRec((o.blackoutWindows as unknown[])[0]).approved = true;
        }),
        ['blackoutWindows', 0],
      ),
    ).toBe(true);
  });

  it('AT-4: values are not coerced', () => {
    expect(passes(clone((o) => (o.maxTeamOverlapPercent = '30')))).toBe(false);
    expect(passes(clone((o) => (o.version = 1)))).toBe(false);
  });

  it('AT-5: schema module is pure (no fs, crypto, yaml or clock)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./leave-policy.schema.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"](node:)?fs(\/promises)?['"]/);
    expect(src).not.toMatch(/from\s+['"](node:)?crypto['"]/);
    expect(src).not.toMatch(/from\s+['"]yaml['"]/);
    expect(src).not.toMatch(/require\(\s*['"](node:)?(fs|crypto)|require\(\s*['"]yaml/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new\s+Date\(\s*\)/);
  });

  it('AT-6: leaveTypes must equal the LeaveType set exactly', () => {
    const missing = clone((o) => {
      o.leaveTypes = ['annual', 'sick', 'unpaid', 'bereavement', 'parental'];
    });
    const extra = clone((o) => {
      (o.leaveTypes as string[]).push('sabbatical');
    });
    const dup = clone((o) => {
      (o.leaveTypes as string[]).push('annual');
    });
    for (const bad of [missing, extra, dup]) {
      expect(failsAtPrefix(bad, ['leaveTypes'])).toBe(true);
    }
  });

  it('AT-7: minNoticeWorkingDays shape and values', () => {
    expect(
      passes(
        clone((o) => {
          delete asRec(o.minNoticeWorkingDays).sick;
        }),
      ),
    ).toBe(false);
    expect(
      passes(
        clone((o) => {
          asRec(o.minNoticeWorkingDays).sabbatical = 3;
        }),
      ),
    ).toBe(false);
    for (const bad of [-1, 1.5, '5']) {
      expect(
        passes(
          clone((o) => {
            asRec(o.minNoticeWorkingDays).annual = bad;
          }),
        ),
      ).toBe(false);
    }
    expect(
      passes(
        clone((o) => {
          asRec(o.minNoticeWorkingDays).sick = 0;
        }),
      ),
    ).toBe(true);
  });

  it('AT-8: requiredFields shape and values', () => {
    expect(
      failsAtPrefix(
        clone((o) => {
          delete asRec(o.requiredFields).parental;
        }),
        ['requiredFields'],
      ),
    ).toBe(true);
    expect(
      failsAtPrefix(
        clone((o) => {
          asRec(o.requiredFields).unpaid = [];
        }),
        ['requiredFields', 'unpaid'],
      ),
    ).toBe(true);
    expect(
      failsAtPrefix(
        clone((o) => {
          asRec(o.requiredFields).unpaid = ['reason', 'reason'];
        }),
        ['requiredFields', 'unpaid'],
      ),
    ).toBe(true);
    expect(
      failsAtPrefix(
        clone((o) => {
          asRec(o.requiredFields).annual = ['salary'];
        }),
        ['requiredFields', 'annual'],
      ),
    ).toBe(true);
  });

  it('AT-9: alwaysEscalate entries are unique leave types', () => {
    expect(passes(clone((o) => (o.alwaysEscalate = ['sabbatical'])))).toBe(false);
    expect(passes(clone((o) => (o.alwaysEscalate = ['unpaid', 'unpaid'])))).toBe(false);
    expect(passes(clone((o) => (o.alwaysEscalate = [])))).toBe(true);
  });

  it('AT-10: blackout windows', () => {
    expect(
      failsAtExact(
        clone((o) => {
          o.blackoutWindows = [
            { id: 'bw-year-end', start: '2026-12-31', end: '2026-12-21', label: 'Year-end close' },
          ];
        }),
        ['blackoutWindows', 0, 'end'],
      ),
    ).toBe(true);
    expect(
      passes(
        clone((o) => {
          o.blackoutWindows = [
            { id: 'bw-sat', start: '2026-12-26', end: '2026-12-26', label: 'Saturday' },
          ];
        }),
      ),
    ).toBe(true);
    expect(
      passes(
        clone((o) => {
          o.blackoutWindows = [
            { id: 'bw-bad', start: '2027-02-29', end: '2027-03-02', label: 'Bad date' },
          ];
        }),
      ),
    ).toBe(false);
    expect(
      failsAtPrefix(
        clone((o) => {
          o.blackoutWindows = [
            { id: 'bw-a', start: '2026-12-01', end: '2026-12-02', label: 'A' },
            { id: 'bw-a', start: '2026-12-05', end: '2026-12-06', label: 'B' },
          ];
        }),
        ['blackoutWindows'],
      ),
    ).toBe(true);
    expect(
      BlackoutWindow.safeParse({ id: 'bw-x', start: '2026-12-02', end: '2026-12-01', label: 'x' })
        .success,
    ).toBe(false);
  });

  it('AT-11: maxTeamOverlapPercent is an integer 0..100', () => {
    for (const ok of [0, 100])
      expect(passes(clone((o) => (o.maxTeamOverlapPercent = ok)))).toBe(true);
    for (const bad of [-1, 101, 0.3, 33.5]) {
      expect(passes(clone((o) => (o.maxTeamOverlapPercent = bad)))).toBe(false);
    }
  });

  it('AT-12: escalateAboveConsecutiveWorkingDays is an integer >= 1', () => {
    expect(passes(clone((o) => (o.escalateAboveConsecutiveWorkingDays = 1)))).toBe(true);
    for (const bad of [0, 9.5]) {
      expect(passes(clone((o) => (o.escalateAboveConsecutiveWorkingDays = bad)))).toBe(false);
    }
  });

  it('AT-13: effectiveFrom must be a real calendar date, any era', () => {
    expect(passes(clone((o) => (o.effectiveFrom = '2099-01-01')))).toBe(true);
    expect(passes(clone((o) => (o.effectiveFrom = '2000-01-01')))).toBe(true);
    expect(passes(clone((o) => (o.effectiveFrom = '2026-13-01')))).toBe(false);
  });

  it('AT-21: LoadedLeavePolicy and PolicyHash shapes', () => {
    const hash = 'a'.repeat(64);
    expect(PolicyHash.safeParse(hash).success).toBe(true);
    expect(PolicyHash.safeParse('A'.repeat(64)).success).toBe(false);
    expect(PolicyHash.safeParse('abc').success).toBe(false);
    expect(
      LoadedLeavePolicy.safeParse({ policy: clone(), policyVersion: 'v1', policyHash: hash })
        .success,
    ).toBe(true);
    expect(
      LoadedLeavePolicy.safeParse({
        policy: clone(),
        policyVersion: 'v1',
        policyHash: hash,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('AT-25: committed policies/leave/v1.yaml parses with LeavePolicyV1 from this gate test', () => {
    const yamlPath = fileURLToPath(new URL('../../../policies/leave/v1.yaml', import.meta.url));
    const raw: unknown = parse(readFileSync(yamlPath, 'utf8'), { schema: 'core', version: '1.2' });
    const result = LeavePolicyV1.safeParse(raw);
    expect(result.success).toBe(true);
    expect(raw).toEqual(V1);
  });
});
