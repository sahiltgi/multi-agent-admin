// Status pill (spec employee-chat, rule 6). Display only: the text is the server's status string
// unchanged, and the tone is an exact-string lookup, never a prefix, substring or case-folded match.
import type { Tone } from './VerdictBadge.js';

// eslint-disable-next-line react-refresh/only-export-components -- spec employee-chat AT-8 checks this exact-key table from this module; it is a static constant, so fast refresh loses nothing.
export const STATUS_TONE: Readonly<Record<string, Tone>> = {
  open: 'amber', // ApprovalStatus: waiting on a human
  approved: 'neutral',
  rejected: 'grey',
  resolved: 'neutral',
  leave_submitted: 'neutral', // ChatStatus
  leave_returned: 'grey',
  escalated: 'plum',
  escalated_to_hr: 'plum',
};

function toneOf(status: string): Tone {
  return Object.hasOwn(STATUS_TONE, status) ? (STATUS_TONE[status] ?? 'neutral') : 'neutral';
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className="pill mono" data-tone={toneOf(status)}>
      {status}
    </span>
  );
}
