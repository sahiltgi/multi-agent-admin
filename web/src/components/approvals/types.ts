// Web-local shapes for the approval cards (spec approval-queue-ui, "Web-local shapes"). Derived
// from the facade type, never redeclared (web-shell rule 16).
import type { ActionBody, ApprovalItemView } from '@hr/shared';

export type View = ApprovalItemView;
export type TabKey = 'leave' | 'hr';

/** What every card gets from the route: its view, its comment draft and the action callbacks. */
export interface CardProps {
  view: View;
  draft: string;
  busy: boolean; // a POST is in flight somewhere on the route (rule 14)
  onDraft: (text: string) => void;
  onAction: (body: ActionBody) => void;
}
