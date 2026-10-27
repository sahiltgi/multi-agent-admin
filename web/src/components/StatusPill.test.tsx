// Spec employee-chat: AT-8 (rule 6). StatusPill shows its input byte-identical, tone by exact key.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS_TONE, StatusPill } from './StatusPill.js';

afterEach(cleanup);

const TABLE: [string, string][] = [
  ['open', 'amber'],
  ['approved', 'neutral'],
  ['rejected', 'grey'],
  ['resolved', 'neutral'],
  ['leave_submitted', 'neutral'],
  ['leave_returned', 'grey'],
  ['escalated', 'plum'],
  ['escalated_to_hr', 'plum'],
  ['question', 'neutral'],
  ['NEW_STATUS_X', 'neutral'],
  ['PENDING_X', 'neutral'],
  ['Approved', 'neutral'],
  ['APPROVED', 'neutral'],
  ['approved_extra', 'neutral'],
  ['OPEN', 'neutral'],
];

describe('StatusPill', () => {
  it('AT-8: text equals the input exactly and data-tone follows the exact-key table', () => {
    for (const [input, tone] of TABLE) {
      const { container } = render(<StatusPill status={input} />);
      const el = container.querySelector<HTMLElement>('[data-tone]');
      expect(el, input).not.toBeNull();
      expect(el?.textContent, input).toBe(input);
      expect(el?.getAttribute('data-tone'), input).toBe(tone);
      cleanup();
    }
  });

  it('AT-8: STATUS_TONE holds exactly the eight server strings', () => {
    expect(Object.keys(STATUS_TONE).sort()).toEqual(
      [
        'open',
        'approved',
        'rejected',
        'resolved',
        'leave_submitted',
        'leave_returned',
        'escalated',
        'escalated_to_hr',
      ].sort(),
    );
  });

  it('AT-8: inherited object keys such as constructor and __proto__ are neutral', () => {
    for (const input of ['constructor', '__proto__', 'toString']) {
      const { container } = render(<StatusPill status={input} />);
      expect(container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral');
      cleanup();
    }
  });
});
