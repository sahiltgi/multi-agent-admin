// One trace step (spec audit-view, rules 20, 21 and 25). Every value is the server's projected
// field rendered as a text child; a null field shows nothing, never 0. The injection mark is
// display only: it changes no badge, pill, verdict, order or control.
import type { TraceTimelineResponse } from '@hr/shared';
import { TEXT } from '../../texts.js';
import { RuleRows } from '../approvals/RuleRows.js';
import { StatusPill } from '../StatusPill.js';
import { VerdictBadge } from '../VerdictBadge.js';

export type Step = TraceTimelineResponse['steps'][number];

const STAGE_LABEL: Readonly<Record<Step['stage'], string>> = {
  orchestrator: TEXT.stageOrchestrator,
  agent: TEXT.stageAgent,
  tool: TEXT.stageTool,
  gate: TEXT.stageGate,
  human: TEXT.stageHuman,
  system: TEXT.stageSystem,
};

function Field({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </>
  );
}

export function TimelineStep({ step }: { step: Step }) {
  const { injection, tokens, input, gate, human } = step;
  const mark = injection.flagged ? 'flagged' : injection.suspected ? 'suspected' : undefined;
  return (
    <li className="step" data-stage={step.stage} data-injection={mark}>
      <div className="step-head">
        <span className="step-stage">{STAGE_LABEL[step.stage]}</span>
        <span>{step.eventType}</span>
        <span className="mono">{step.at}</span>
        <span className="mono">{step.actor.kind}</span>
        <span className="mono">{step.actor.id}</span>
        {step.isError === true ? <span className="step-error">{TEXT.stepError}</span> : null}
      </div>
      {mark === undefined ? null : (
        <p className="step-injection">
          <span className="step-injection-label">
            {mark === 'flagged' ? TEXT.injectionFlagged : TEXT.injectionSuspected}
          </span>
          {injection.source === null ? null : <span className="mono"> {injection.source}</span>}
          {injection.excerpt === null ? null : <span className="pre"> {injection.excerpt}</span>}
        </p>
      )}
      <dl className="fields">
        <Field label="kind" value={step.kind} />
        <Field label="agent" value={step.agent} />
        <Field label="model" value={step.model} />
        <Field label="promptVersion" value={step.promptVersion} />
        <Field label="tool" value={step.tool} />
        <Field
          label={TEXT.labelTokens}
          value={
            tokens === null
              ? null
              : `${String(tokens.input)} ${TEXT.tokensIn} / ${String(tokens.output)} ${TEXT.tokensOut}`
          }
        />
        <Field
          label={TEXT.labelLatency}
          value={step.latencyMs === null ? null : `${String(step.latencyMs)} ${TEXT.latencyUnit}`}
        />
      </dl>
      {input === null ? null : (
        <div className="step-input">
          <span className="muted">{TEXT.labelInput}</span>
          <span className="mono pre">
            {input.text}
            {input.truncated ? TEXT.truncatedMark : null}
          </span>
        </div>
      )}
      {gate !== null ? (
        <div className="step-gate">
          <VerdictBadge verdict={gate.verdict} />
          <span className="mono">{gate.policyVersion}</span>
          <RuleRows rows={gate.ruleResults} />
        </div>
      ) : step.eventType === 'gate_result' ? (
        <p className="muted">{TEXT.noGateResult}</p>
      ) : null}
      {human === null ? null : (
        <div className="step-human">
          <span>{human.action}</span>
          <span className="mono">{human.actorRole}</span>
          <StatusPill status={human.statusBefore} />
          <StatusPill status={human.statusAfter} />
        </div>
      )}
    </li>
  );
}
