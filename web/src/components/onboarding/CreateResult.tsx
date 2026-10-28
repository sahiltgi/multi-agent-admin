// The create outcome, exactly as returned (spec onboarding-ui, rule 6). The badge is the only
// verdict shown, copied from the server; nothing branches on it. A created checklist opens in the
// "Just added" region, whatever its place in the list, until the next create replaces it.
import type { ChecklistView, CreateOnboardingResponse } from '@hr/shared';
import type { ApiResult } from '../../api/client.js';
import { TEXT } from '../../texts.js';
import { VerdictBadge } from '../VerdictBadge.js';
import { ChecklistCard, PendingMarker } from './ChecklistCard.js';

type Created = Extract<CreateOnboardingResponse, { kind: 'checklist_created' }>;
type Escalated = Extract<CreateOnboardingResponse, { kind: 'escalated' }>;

export function EscalatedResult({ outcome }: { outcome: Escalated }) {
  return (
    <div className="create-result">
      <p>{outcome.text}</p>
      <p className="mono">{outcome.reason}</p>
      {outcome.agentReason === null ? null : <p className="mono">{outcome.agentReason}</p>}
    </div>
  );
}

export function CreatedResult({
  outcome,
  busy,
  onTick,
}: {
  outcome: Created;
  busy: boolean;
  onTick: (checklistId: string, taskId: string) => Promise<ApiResult<ChecklistView>> | null;
}) {
  return (
    <section className="create-result" aria-label={TEXT.justAdded}>
      <h2 className="section-title">{TEXT.justAdded}</h2>
      <p>{outcome.text}</p>
      <p className="card-head">
        <VerdictBadge verdict={outcome.verdict} />
        <span className="mono">{outcome.checklistId}</span>
        <PendingMarker n={outcome.pendingDeviationIds.length} />
      </p>
      <ChecklistCard
        checklistId={outcome.checklistId}
        summary={null}
        startOpen
        busy={busy}
        onTick={onTick}
      />
    </section>
  );
}
