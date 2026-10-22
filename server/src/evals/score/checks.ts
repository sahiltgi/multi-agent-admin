// Check builders shared by the per-agent scorers (spec eval-runner, rule 16). Pure.
import type { Check, ObservedValue } from '../schemas.js';

const TOKEN = /^[A-Za-z0-9_.:-]*$/;

/** A string safe to store as an observed value, or null for anything that isn't a short token. */
export function token(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 64 && TOKEN.test(v) ? v : null;
}

/**
 * A record of token keys to token-or-null values, or null when `v` isn't an object. Built with
 * Object.fromEntries, so a `__proto__` key stays an own property and never reaches a prototype.
 */
export function tokenRecord(v: unknown): Record<string, string | null> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => token(k) !== null)
      .map(([k, val]) => [k, val === null ? null : token(val)]),
  );
}

/** An own property only; never a value inherited from Object.prototype. */
export const own = (
  r: Readonly<Record<string, string | null>>,
  k: string,
): string | null | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);

export function tokens(v: unknown): string[] {
  return Array.isArray(v) ? v.map(token).filter((t): t is string => t !== null) : [];
}

export function check(
  field: string,
  passed: boolean,
  expected: ObservedValue,
  actual: ObservedValue,
): Check {
  return { field, passed, expected, actual };
}

/**
 * Equality of a scalar expected value (token string, number, boolean or null). An expected value of
 * any other shape can't be compared, so it fails and is recorded as null.
 */
export function equal(
  field: string,
  expected: unknown,
  actual: string | number | boolean | null,
): Check {
  if (typeof expected === 'number' || typeof expected === 'boolean' || expected === null) {
    return check(field, expected === actual, expected, actual);
  }
  const exp = token(expected);
  return check(field, exp !== null && exp === actual, exp, actual);
}

export const sorted = (xs: readonly string[]): string[] => [...xs].sort();

export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
