// Draft rendering (spec chat-endpoint rule 13; D-2). The Leave Agent's userText for a continuation
// is the draft_template file with one left-to-right substitution pass, so placeholder-like text
// inside a substituted value is never substituted again. The runtime wraps the result once as
// user data (agent-runtime D-8), so the labels in it are data too.
import type { LeaveDraft } from './schemas.js';

const PLACEHOLDER = /\{(earlier|question|latest)\}/g;

export function renderDraft(template: string, draft: LeaveDraft, latest: string): string {
  const values = {
    earlier: draft.messages.join('\n\n'),
    question: draft.lastQuestion,
    latest,
  };
  // One replace call scans the template only; replacement values are never rescanned.
  return template.replace(PLACEHOLDER, (_m, key: keyof typeof values) => values[key]).trim();
}
