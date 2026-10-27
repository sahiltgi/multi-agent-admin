// Frozen-date clock for the e2e server (spec e2e-demo, rule 6). The date stays at the epoch's for
// the whole run, while deadlines and latencies still advance with real elapsed time.
import type { Clock } from '../agents/runtime.js';

/** A Monday. e2e/helpers.ts fixes the browser clock to the same instant. */
export const E2E_EPOCH_ISO = '2026-11-09T09:00:00.000Z';

export function e2eClock(epochMs: number, realNowMs: () => number = Date.now): Clock {
  const start = realNowMs();
  const nowMs = (): number => epochMs + (realNowMs() - start);
  return {
    nowMs,
    nowIso: () => new Date(nowMs()).toISOString(),
  };
}
