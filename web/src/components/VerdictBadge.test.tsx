// Spec web-shell, AT-16: exact-string tone lookup. Assumes `<VerdictBadge verdict={string} />`.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VerdictBadge } from './VerdictBadge.js';

afterEach(cleanup);

describe('VerdictBadge', () => {
  it('AT-16: shows the verdict unchanged with a tone from an exact-string lookup', () => {
    const table: [string, string][] = [
      ['ROUTE_TO_MANAGER', 'neutral'],
      ['AUTO_ANSWER', 'neutral'],
      ['AUTO', 'neutral'],
      ['ROUTE_TO_MANAGER_WITH_FLAGS', 'amber'],
      ['MANAGER', 'amber'],
      ['ESCALATE_TO_HR', 'plum'],
      ['RETURN_TO_EMPLOYEE', 'grey'],
      ['NEW_VERDICT_X', 'neutral'],
      ['route_to_manager', 'neutral'],
      ['SOMETHING_WITH_FLAGS', 'neutral'],
    ];
    for (const [verdict, tone] of table) {
      const { container, unmount } = render(<VerdictBadge verdict={verdict} />);
      const badge = container.querySelector<HTMLElement>('[data-tone]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe(verdict);
      expect(badge?.getAttribute('data-tone')).toBe(tone);
      unmount();
    }
  });
});
