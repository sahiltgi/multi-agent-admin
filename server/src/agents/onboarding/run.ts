// runOnboardingAgent (spec onboarding, rules 10–18). Runs the shared runtime with the three
// onboarding tools, then decides in code: post-run validation, at most one gate call, and the
// audit trail. The model only extracts details and proposes deviations; it never sets a verdict,
// a task, a due date or an owner, and nothing is persisted here (dispatch does that).
import { z } from 'zod';
import {
  MAX_DEVIATIONS_PER_RUN,
  normaliseTitle,
  OnboardingGateResult,
  type DeviationChange,
} from '../../domain/onboarding.js';
import { AuditEvent } from '../../domain/schemas.js';
import type { AuditSink } from '../audit.js';
import { hasNoDecisionLanguage } from '../leave/schemas.js';
import { ClarifyingQuestion } from '../orchestrator/schemas.js';
import { createRuntime, type RunResult } from '../runtime.js';
import { ONBOARDING_CONFIG } from './config.js';
import {
  CreateChecklistOutput,
  OnboardingAgentResult,
  OnboardingGateResultPayload,
  OnboardingInjectionPayload,
  OnboardingInput,
  OnboardingOutcomePayload,
  ProposeDeviationOutput,
  type OnboardingEscalation,
  type ProposedDeviation,
} from './schemas.js';
import type { OnboardingAgentTextKey } from './texts.js';
import type { OnboardingAgentDeps } from './tools.js';

export type { OnboardingAgentDeps } from './tools.js';

class AuditWriteFailed extends Error {}

/** The runtime's injection_flagged payload; only the fields copied into the agent summary. */
export const RuntimeFlag = z.looseObject({
  input: z.looseObject({
    source: z.enum(['user', 'document', 'tool']),
    tool: z.string().optional(),
    excerpt: z.string(),
    reason: z.string().optional(),
  }),
});
export type RuntimeFlag = z.infer<typeof RuntimeFlag>['input'];

/** An audit sink that notes this run's injection flags and passes every event on (rule 17). */
export function flagTap(inner: AuditSink, requestId: string, flags: RuntimeFlag[]): AuditSink {
  return {
    write(event) {
      if (event.eventType === 'injection_flagged' && event.traceId === requestId) {
        const flag = RuntimeFlag.safeParse(event.payload);
        if (flag.success) flags.push(flag.data.input);
      }
      return inner.write(event);
    },
  };
}

/** Byte-identical file text, or null when missing, blank or unreadable (fail closed). */
export async function loadText(
  deps: OnboardingAgentDeps,
  key: OnboardingAgentTextKey,
): Promise<string | null> {
  try {
    const res = await deps.texts.load(key);
    return res.found && res.text.trim() !== '' ? res.text : null;
  } catch {
    return null;
  }
}

/**
 * Rule 14: is this set of proposals coherent with the code-built tasks? Shared with the notes-mode
 * agent (spec onboarding-api, rule 4), which validates against the same tasks.
 */
export function deviationsValid(
  tasks: readonly { id: string; dependsOn: readonly string[] }[],
  changes: readonly DeviationChange[],
): boolean {
  if (changes.length > MAX_DEVIATIONS_PER_RUN) return false;
  const onChecklist = new Set(tasks.map((t) => t.id));
  const removed = new Set<string>();
  const titles = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'remove') {
      if (!onChecklist.has(c.templateTaskId) || removed.has(c.templateTaskId)) return false;
      removed.add(c.templateTaskId);
    } else {
      const title = normaliseTitle(c.title);
      if (titles.has(title)) return false;
      titles.add(title);
    }
  }
  for (const c of changes) {
    if (c.kind === 'add' && c.dependsOn.some((d) => !onChecklist.has(d) || removed.has(d))) {
      return false;
    }
  }
  // A remaining template task may not depend on a removed one.
  return !tasks.some((t) => !removed.has(t.id) && t.dependsOn.some((d) => removed.has(d)));
}

type Built =
  | { result: OnboardingAgentResult; gate: null }
  | { result: OnboardingAgentResult & { kind: 'checklist' }; gate: OnboardingGateResult };

async function build(
  run: RunResult,
  deps: OnboardingAgentDeps,
  requestId: string,
  flagged: boolean,
): Promise<Built> {
  const escalate = (reason: OnboardingEscalation): Built => ({
    result: { kind: 'escalated', requestId, reason, injectionSuspected: flagged },
    gate: null,
  });
  const ask = (question: string, questionSource: 'model' | 'fallback'): Built => ({
    result: {
      kind: 'needs_details',
      requestId,
      question,
      questionSource,
      injectionSuspected: flagged,
    },
    gate: null,
  });

  // Rule 16: any outcome other than completed escalates; only an API timeout or error is
  // model_unavailable.
  if (run.outcome !== 'completed') {
    if (run.outcome === 'error' && run.code === 'audit_failed') return escalate('audit_failed');
    const apiFailure =
      run.outcome === 'timeout' || (run.outcome === 'error' && run.code === 'model_error');
    return escalate(apiFailure ? 'model_unavailable' : 'run_not_completed');
  }
  // is_error calls never reach toolCalls, so a rejected call doesn't count (rule 13).
  const creations = run.toolCalls.filter((c) => c.tool === 'create_checklist');
  const proposals = run.toolCalls.filter((c) => c.tool === 'propose_deviation');
  if (creations.length > 1) return escalate('multiple_checklists');
  const [creation] = creations;
  if (creation === undefined) {
    if (proposals.length > 0) return escalate('deviation_without_checklist');
    // Rule 15: ask, never guess.
    const text = run.text;
    if (ClarifyingQuestion.safeParse(text).success && hasNoDecisionLanguage(text)) {
      return ask(text, 'model');
    }
    const fallback = await loadText(deps, 'fallback_question');
    if (fallback === null || !ClarifyingQuestion.safeParse(fallback).success) {
      return escalate('fallback_text_missing');
    }
    return ask(fallback, 'fallback');
  }

  const checklist = CreateChecklistOutput.parse(creation.output);
  const deviations: ProposedDeviation[] = proposals.map((p, index) => {
    const out = ProposeDeviationOutput.parse(p.output);
    return { index, change: out.change, rationale: out.rationale };
  });
  const changes = deviations.map((d) => d.change);
  if (!deviationsValid(checklist.tasks, changes)) return escalate('invalid_deviation');

  // OQ-7: a start date before today (injected clock, UTC) is asked again.
  const today = deps.toIsoDate(deps.runtime.clock.nowIso());
  if (checklist.startDate < today) {
    const past = await loadText(deps, 'start_date_past');
    if (past === null || !ClarifyingQuestion.safeParse(past).success) {
      return escalate('fallback_text_missing');
    }
    return ask(past, 'fallback');
  }

  // Rule 16: one gate call with the code-built input; the rationale never reaches it.
  const gate = OnboardingGateResult.parse(
    deps.evaluateOnboarding(
      {
        templateId: checklist.templateId,
        startDate: checklist.startDate,
        assignees: checklist.assignees,
        checklistTasks: checklist.tasks,
        deviations: changes,
      },
      deps.policy,
    ),
  );
  return {
    result: {
      kind: 'checklist',
      requestId,
      checklist,
      deviations,
      gate,
      injectionSuspected: flagged,
    },
    gate,
  };
}

export async function runOnboardingAgent(
  input: unknown,
  deps: OnboardingAgentDeps,
): Promise<OnboardingAgentResult> {
  const parsed = OnboardingInput.parse(input); // throws before any model call or audit write
  const { requestId } = parsed;
  const { runtime } = deps;
  // Rule 17: note this run's injection flags; the run itself never changes because of them.
  const flags: RuntimeFlag[] = [];
  const tap = flagTap(runtime.audit, requestId, flags);

  const run = await createRuntime(ONBOARDING_CONFIG, { ...runtime, audit: tap }).run(parsed);
  const flagged = flags.length > 0;
  const built = await build(run, deps, requestId, flagged);
  // agent-runtime D-14: after a sink failure nothing more is written.
  if (built.result.kind === 'escalated' && built.result.reason === 'audit_failed') {
    return OnboardingAgentResult.parse(built.result);
  }

  const write = async (
    eventType: AuditEvent['eventType'],
    actor: AuditEvent['actor'],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await runtime.audit.write(
        AuditEvent.parse({
          id: runtime.idGen(),
          traceId: requestId,
          at: runtime.clock.nowIso(),
          actor,
          eventType,
          payload,
        }),
      );
    } catch {
      throw new AuditWriteFailed();
    }
  };
  const agent = { kind: 'agent' as const, id: 'onboarding' };

  try {
    // A flat summary of each flag, so a reader sees its source without unpacking runtime input.
    for (const f of flags) {
      await write(
        'injection_flagged',
        agent,
        OnboardingInjectionPayload.parse({
          kind: 'injection_flagged',
          requestId,
          agent: 'onboarding',
          source: f.source,
          tool: f.tool ?? null,
          excerpt: f.excerpt, // redacted and bounded by the runtime
          reason: f.reason ?? null,
        }),
      );
    }
    if (built.gate !== null) {
      // Unredacted: the gate output holds template-only text plus the policy hash (rule 8).
      await write(
        'gate_result',
        { kind: 'gate', id: 'onboarding' },
        OnboardingGateResultPayload.parse({
          kind: 'onboarding_gate_result',
          requestId,
          ...built.gate,
        }),
      );
    }
    const { result } = built;
    await write(
      'agent_step',
      agent,
      OnboardingOutcomePayload.parse({
        kind: 'onboarding_outcome',
        requestId,
        outcome: result.kind,
        escalation: result.kind === 'escalated' ? result.reason : null,
        deviationCount: result.kind === 'checklist' ? result.deviations.length : 0,
        injectionSuspected: flagged,
        model: ONBOARDING_CONFIG.model,
        promptVersion: ONBOARDING_CONFIG.promptVersion,
      }),
    );
  } catch (err) {
    if (!(err instanceof AuditWriteFailed)) throw err;
    return OnboardingAgentResult.parse({
      kind: 'escalated',
      requestId,
      reason: 'audit_failed',
      injectionSuspected: flagged,
    });
  }
  return OnboardingAgentResult.parse(built.result);
}
