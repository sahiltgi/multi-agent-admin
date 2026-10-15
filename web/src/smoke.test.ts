import { describe, expect, it } from 'vitest';

describe('web toolchain', () => {
  it('runs tests in a DOM environment', () => {
    expect(typeof document).toBe('object');
  });
});
