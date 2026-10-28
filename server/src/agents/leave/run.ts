// runLeaveAgent (spec leave-agent, rules 7, 9 to 14; D-1, D-7, D-11, D-12, D-16). Runs the shared
// runtime with the five leave tools, then builds the result in code. The card's verdict and rule
// results are copied from the gate output; model text is used only after it passes its checks.
import { AuditEvent } from '../../domain/schemas.js';
import type { AuditSink } from '../audit.js';
import { ClarifyingQuestion } from '../orchestrator/schemas.js';
import { createRuntime, type RunResult } from '../runtime.js';
import { LEAVE_CONFIG } from './config.js';
import {
  type EscalationReason,
  LeaveAgentResult,
  LeaveAuditPayload,
  LeaveInput,
  ModelSummary,
  RecommendationCard,
  SubmitToGateOutput,
  hasNoDecisionLanguage,
} from './schemas.js';
import type { LeaveTextKey } from './texts.js';
import { beginRun, endRun, runState, type LeaveAgentDeps } from './tools.js';

export type { LeaveAgentDeps } from './tools.js';

/** Byte-identical file text, or null when missing, blank or unreadable (fail closed). */
async function loadText(deps: LeaveAgentDeps, key: LeaveTextKey): Promise<string | null> {
  try {
    const res = await deps.texts.load(key);
    return res.found && res.text.trim() !== '' ? res.text : null;
  } catch {
    return null;
  }
}

/** Rule 11 / D-11: filled only from gate fields, never from model text. */
function renderSummary(template: string, out: SubmitToGateOutput): string {
  const failed = out.gate.ruleResults.filter((r) => !r.passed).map((r) => r.ruleId);
  return template
    .replaceAll('{verdict}', out.gate.verdict)
    .replaceAll('{failedRules}', failed.length === 0 ? 'none' : failed.join(', '))
    .trim();
}

interface Built {
  result: LeaveAgentResult;
  summarySource: 'model' | 'fallback' | null;
}

async function build(
  run: RunResult,
  deps: LeaveAgentDeps,
  requestId: string,
  employeeId: string,
  flagged: boolean,
  gateRuns: number,
): Promise<Built> {
  const escalate = (reason: EscalationReason) =>
    ({
      result: { kind: 'escalated', requestId, reason, injectionSuspected: flagged },
      summarySource: null,
    }) as const;

  // Rule 12: any outcome other than completed escalates, even after a successful submission.
  // chat-endpoint rule 16: only an API timeout or error is model_unavailable (a retry on /chat).
  if (run.outcome !== 'completed') {
    const apiFailure =
      run.outcome === 'timeout' || (run.outcome === 'error' && run.code === 'model_error');
    return escalate(apiFailure ? 'model_unavailable' : 'run_not_completed');
  }
  const submissions = run.toolCalls.filter((c) => c.tool === 'submit_to_gate');
  // Rule 9 / D-12: no shopping for a better verdict. is_error calls never reach toolCalls.
  // A gate evaluation whose tool call then failed (e.g. its gate_result write) still counts.
  const gateCalls = Math.max(submissions.length, gateRuns);
  if (gateCalls > 1) return escalate('multiple_submissions');
  // chat-endpoint rule 15: never a card plus a switch. Code sees the call, never model text.
  if (run.toolCalls.some((c) => c.tool === 'hand_back')) {
    if (gateCalls === 1) return escalate('hand_back_conflict');
    return {
      result: { kind: 'hand_back', requestId, injectionSuspected: flagged },
      summarySource: null,
    };
  }

  const [submission] = submissions;
  if (submission === undefined) {
    // Rule 7 / D-7: ask, never guess.
    const text = run.text;
    if (ClarifyingQuestion.safeParse(text).success && hasNoDecisionLanguage(text)) {
      return {
        result: {
          kind: 'needs_details',
          requestId,
          question: text,
          questionSource: 'model',
          injectionSuspected: flagged,
        },
        summarySource: null,
      };
    }
    const fallback = await loadText(deps, 'fallback_question');
    if (fallback === null || !ClarifyingQuestion.safeParse(fallback).success) {
      return escalate('fallback_text_missing');
    }
    return {
      result: {
        kind: 'needs_details',
        requestId,
        question: fallback,
        questionSource: 'fallback',
        injectionSuspected: flagged,
      },
      summarySource: null,
    };
  }

  // Rule 10: everything on the card except the summary is copied from the gate output.
  const out = SubmitToGateOutput.parse(submission.output);
  const modelSummary = ModelSummary.safeParse(run.text);
  let summary: string;
  let summarySource: 'model' | 'fallback';
  if (modelSummary.success) {
    summary = modelSummary.data;
    summarySource = 'model';
  } else {
    const template = await loadText(deps, 'summary_template');
    if (template === null) return escalate('fallback_text_missing');
    summary = renderSummary(template, out);
    summarySource = 'fallback';
  }
  const card = RecommendationCard.parse({
    requestId,
    employeeId,
    request: out.request,
    today: out.today,
    verdict: out.gate.verdict,
    ruleResults: out.gate.ruleResults,
    reason: out.gate.reason,
    policyVersion: out.gate.policyVersion,
    policyHash: out.gate.policyHash,
    summary,
    summarySource,
    model: run.model,
    promptVersion: run.promptVersion,
  });
  return { result: { kind: 'card', card, injectionSuspected: flagged }, summarySource };
}

export async function runLeaveAgent(
  input: unknown,
  deps: LeaveAgentDeps,
): Promise<LeaveAgentResult> {
  const parsed = LeaveInput.parse(input); // throws before any model call or audit write
  const { requestId } = parsed;
  const { runtime } = deps;
  // D-1: note this run's injection_flagged events; the run itself never changes because of them.
  const tap: AuditSink = {
    write(event) {
      if (event.eventType === 'injection_flagged' && event.traceId === requestId) {
        const state = runState(deps, requestId);
        if (state !== undefined) state.injectionSuspected = true;
      }
      return runtime.audit.write(event);
    },
  };

  beginRun(deps, requestId);
  try {
    const run = await createRuntime(LEAVE_CONFIG, { ...runtime, audit: tap }).run(parsed);
    const state = runState(deps, requestId);
    const flagged = state?.injectionSuspected === true;
    const { result, summarySource } = await build(
      run,
      deps,
      requestId,
      parsed.actor.employeeId,
      flagged,
      state?.gateRuns ?? 0,
    );
    // agent-runtime D-14: after a sink failure nothing more is written. The result is escalated
    // and carries no verdict.
    if (!(run.outcome === 'error' && run.code === 'audit_failed')) {
      const payload = LeaveAuditPayload.parse({
        requestId,
        agent: 'leave',
        kind: 'leave_outcome',
        outcome: result.kind,
        gate: null,
        summarySource,
        injectionSuspected: flagged,
        model: run.model, // the model actually called (spec gemini-fallback, rule 8)
        promptVersion: LEAVE_CONFIG.promptVersion,
      });
      // Rule 14: the last leave event. A sink rejection propagates; no unaudited outcome returns.
      await runtime.audit.write(
        AuditEvent.parse({
          id: runtime.idGen(),
          traceId: requestId,
          at: runtime.clock.nowIso(),
          actor: { kind: 'agent', id: 'leave' },
          eventType: 'agent_step',
          payload,
        }),
      );
    }
    return LeaveAgentResult.parse(result);
  } finally {
    endRun(deps, requestId);
  }
}
