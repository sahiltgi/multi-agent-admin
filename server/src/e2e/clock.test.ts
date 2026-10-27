// Spec e2e-demo, rule 6 (AT-12). Frozen-date clock: the date is fixed, elapsed time still advances.
import { describe, expect, it } from 'vitest';
import { E2E_EPOCH_ISO, e2eClock } from './clock.js';

describe('e2eClock', () => {
  it('AT-12: advances with the injected real clock and keeps the date 2026-11-09', () => {
    expect(E2E_EPOCH_ISO).toBe('2026-11-09T09:00:00.000Z');
    const epochMs = Date.parse(E2E_EPOCH_ISO);
    const reals = [1000, 1250, 1250, 1250]; // the first read captures the start
    let i = 0;
    const realNowMs = (): number => reals[Math.min(i++, reals.length - 1)] ?? 1250;
    const clock = e2eClock(epochMs, realNowMs);

    expect(clock.nowMs()).toBe(epochMs + 250);
    expect(clock.nowIso()).toBe('2026-11-09T09:00:00.250Z');
    expect(clock.nowIso().slice(0, 10)).toBe('2026-11-09');
  });
});
