// runOnboardingNotesAgent (spec onboarding-api, rule 4; OQ-4). The notes-mode Onboarding Agent behind
// POST /onboarding: code has already built the checklist, so the model only reads the template and
// proposes deviations from the requester's free-text notes. It never calls the gate, never builds a
// checklist and persists nothing; the route decides everything from the returned proposals.
import { z } from 'zod';
import { AuditEvent, ChecklistTask } from '../../domain/schemas.js';
import { hasNoDecisionLanguage } from '../leave/schemas.js';
import { createRuntime, type RunResult } from '../runtime.js';
import { ONBOARDING_NOTES_CONFIG } from './config.js';
import { deviationsValid, flagTap, loadText, type RuntimeFlag } from './run.js';
import {
  OnboardingInjectionPayload,
  OnboardingNotesInput,
  OnboardingNotesOutcomePayload,
  OnboardingNotesResult,
  ProposeDeviationOutput,
  type OnboardingEscalation,
  type ProposedDeviation,
} from './schemas.js';
import type { OnboardingAgentDeps } from './tools.js';

class AuditWriteFailed extends Error {}

/**
 * The data block the model receives, wrapped once as untrusted by the runtime. It holds the template
 * id and the notes only: no name, team or employee id (rule 9). The notes stay exactly as written,
 * so the runtime's injection scan sees their real lines (agent-runtime rule 17); JSON escaping would
 * hide a role prefix or a fake tool_use from it. The layout is described to the model in
 * prompts/onboarding/notes_context.md.
 */
function dataBlock(templateId: string, notes: string): string {
  return ['templateId: ' + templateId, 'notes:', notes].join('\n');
}

/** Rule 4: proposals decide; with none, only the exact fixed sentence means "no changes". */
async function decide(
  run: RunResult,
  deps: OnboardingAgentDeps,
  requestId: string,
  tasks: readonly ChecklistTask[],
  flagged: boolean,
): Promise<OnboardingNotesResult> {
  const escalate = (reason: OnboardingEscalation): OnboardingNotesResult => ({
    kind: 'escalated',
    requestId,
    reason,
    injectionSuspected: flagged,
  });
  // As runOnboardingAgent: anything but completed escalates; only an API failure is model_unavailable.
  if (run.outcome !== 'completed') {
    if (run.outcome === 'error' && run.code === 'audit_failed') return escalate('audit_failed');
    const apiFailure =
      run.outcome === 'timeout' || (run.outcome === 'error' && run.code === 'model_error');
    return escalate(apiFailure ? 'model_unavailable' : 'run_not_completed');
  }
  // is_error calls never reach toolCalls, so a rejected call doesn't count.
  const deviations: ProposedDeviation[] = run.toolCalls
    .filter((c) => c.tool === 'propose_deviation')
    .map((c, index) => {
      const out = ProposeDeviationOutput.parse(c.output);
      return { index, change: out.change, rationale: out.rationale };
    });
  if (deviations.length > 0) {
    if (
      !deviationsValid(
        tasks,
        deviations.map((d) => d.change),
      )
    ) {
      return escalate('invalid_deviation');
    }
    // The rationale and an added title are model text shown to the approver: they may restate the
    // request, never claim a decision (HARD RULE 1; onboarding-api ID-6).
    const shown = (d: ProposedDeviation): string[] =>
      d.change.kind === 'add' ? [d.rationale, d.change.title] : [d.rationale];
    if (deviations.some((d) => shown(d).some((text) => !hasNoDecisionLanguage(text)))) {
      return escalate('invalid_deviation');
    }
    return { kind: 'proposals', requestId, deviations, injectionSuspected: flagged };
  }
  // Zero proposals fail closed: any text but the fixed sentence is a question or noise.
  const noChanges = await loadText(deps, 'no_changes');
  if (noChanges === null) return escalate('fallback_text_missing');
  if (run.text.trim() === noChanges.trim()) {
    return { kind: 'proposals', requestId, deviations: [], injectionSuspected: flagged };
  }
  return { kind: 'needs_details', requestId, injectionSuspected: flagged };
}

export async function runOnboardingNotesAgent(
  input: unknown,
  checklistTasks: unknown,
  deps: OnboardingAgentDeps,
): Promise<OnboardingNotesResult> {
  const parsed = OnboardingNotesInput.parse(input); // throws before any model call or audit write
  const tasks = z.array(ChecklistTask).min(1).parse(checklistTasks); // the code-built checklist
  const { requestId } = parsed;
  const { runtime } = deps;
  const flags: RuntimeFlag[] = [];
  const tap = flagTap(runtime.audit, requestId, flags);

  const run = await createRuntime(ONBOARDING_NOTES_CONFIG, { ...runtime, audit: tap }).run({
    requestId,
    agentId: ONBOARDING_NOTES_CONFIG.agentId,
    actor: parsed.actor,
    userText: dataBlock(parsed.templateId, parsed.notes),
    documents: [],
  });
  const flagged = flags.length > 0;
  const result = await decide(run, deps, requestId, tasks, flagged);
  // agent-runtime D-14: after a sink failure nothing more is written.
  if (result.kind === 'escalated' && result.reason === 'audit_failed') {
    return OnboardingNotesResult.parse(result);
  }

  const agent = { kind: 'agent' as const, id: 'onboarding_notes' };
  const write = async (
    eventType: AuditEvent['eventType'],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await runtime.audit.write(
        AuditEvent.parse({
          id: runtime.idGen(),
          traceId: requestId,
          at: runtime.clock.nowIso(),
          actor: agent,
          eventType,
          payload,
        }),
      );
    } catch {
      throw new AuditWriteFailed();
    }
  };

  try {
    for (const f of flags) {
      await write(
        'injection_flagged',
        OnboardingInjectionPayload.parse({
          kind: 'injection_flagged',
          requestId,
          agent: 'onboarding_notes',
          source: f.source,
          tool: f.tool ?? null,
          excerpt: f.excerpt, // redacted and bounded by the runtime
          reason: f.reason ?? null,
        }),
      );
    }
    await write(
      'agent_step',
      OnboardingNotesOutcomePayload.parse({
        kind: 'onboarding_notes_outcome',
        requestId,
        outcome: result.kind,
        escalation: result.kind === 'escalated' ? result.reason : null,
        deviationCount: result.kind === 'proposals' ? result.deviations.length : 0,
        injectionSuspected: flagged,
        model: ONBOARDING_NOTES_CONFIG.model,
        promptVersion: ONBOARDING_NOTES_CONFIG.promptVersion,
      }),
    );
  } catch (err) {
    if (!(err instanceof AuditWriteFailed)) throw err;
    return OnboardingNotesResult.parse({
      kind: 'escalated',
      requestId,
      reason: 'audit_failed',
      injectionSuspected: flagged,
    });
  }
  return OnboardingNotesResult.parse(result);
}
