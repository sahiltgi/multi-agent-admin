// The trace timeline projection (spec audit-view, rules 2–9). Pure: no I/O, clock or randomness.
// Each event becomes one allowlisted TimelineStep, in input order. Every field is read through its
// own narrow parse; a field that is absent or fails its view is null, never guessed (HARD RULE 6).
// Gate output is copied as stored, never evaluated (HARD RULE 1); user text is data (HARD RULE 3).
import { z } from 'zod';
import { QaGateResult } from '../domain/qa.js';
import {
  LeaveGateResult,
  OnboardingGateResult,
  type AuditEvent,
  type RuleResult,
} from '../domain/schemas.js';
import { TokenCount, Usage } from '../lib/cost.js';
import { redact, redactText } from '../lib/redact.js';
import { SUMMARY_KINDS } from '../metrics/ports.js';
import {
  EXCERPT_CHARS,
  HumanView,
  INPUT_PREVIEW_CHARS,
  InjectionView,
  SafeToken,
  type GateView,
  type InputPreview,
  type RequestTotal,
  type TimelineStage,
  type TimelineStep,
} from './schemas.js';

export interface Timeline {
  steps: TimelineStep[];
  injectionCount: number;
  requestTotal: RequestTotal;
}

type Payload = AuditEvent['payload'];

// Rule 4: the kinds that measure tokens, and the kinds whose stored latency is a measurement.
const TOKEN_KINDS: ReadonlySet<unknown> = new Set(['model_call', 'qa_model_call']);
const LATENCY_KINDS: ReadonlySet<unknown> = new Set([
  'model_call',
  'qa_model_call',
  'tool_call',
  'tool_error',
  'tool_output_invalid',
  'run_end',
]);
// Rule 6: the only kinds whose input is projected (model-built tool arguments).
const INPUT_KINDS: ReadonlySet<unknown> = new Set([
  'tool_call',
  'tool_error',
  'tool_input_invalid',
  'tool_output_invalid',
  'tool_denied',
]);
const SUMMARY: ReadonlySet<unknown> = new Set(SUMMARY_KINDS);

const StoredTokens = z.looseObject({
  input: TokenCount.shape.input,
  output: TokenCount.shape.output,
});
const Latency = z.number().int().nonnegative();
const Source = InjectionView.shape.source.unwrap();
const Text = z.string();
const Record = z.record(z.string(), z.unknown());
const HumanFields = z.looseObject(HumanView.shape);

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

/** Rule 3, checked in this order, by exact match. A display label only. */
function stageOf(e: AuditEvent): TimelineStage {
  if (e.eventType === 'gate_result') return 'gate';
  if (e.eventType === 'human_action') return 'human';
  if (e.eventType === 'tool_call' || e.eventType === 'tool_call_denied') return 'tool';
  if (e.actor.kind === 'agent') return e.actor.id === 'orchestrator' ? 'orchestrator' : 'agent';
  return e.actor.kind;
}

/** Redaction runs before the cut, so a cut can't leave part of an address unmasked. */
function cut(text: string, max: number): { text: string; truncated: boolean } {
  const masked = redactText(text);
  return masked.length > max
    ? { text: masked.slice(0, max), truncated: true }
    : { text: masked, truncated: false };
}

function inputOf(p: Payload): InputPreview | null {
  if (!INPUT_KINDS.has(p.kind) || p.input === undefined) return null;
  // Values are masked before serialising (escapes like \n would hide a digit run from the
  // second pass), then the serialised text is masked again in `cut`.
  const json = JSON.stringify(redact(p.input)) as string | undefined;
  return json === undefined ? null : cut(json, INPUT_PREVIEW_CHARS);
}

/**
 * Rule 7. Source and excerpt are read only on injection_flagged events: from `payload.input`
 * (runtime events) or the payload top level (Q&A and onboarding events).
 */
function injectionOf(e: AuditEvent): TimelineStep['injection'] {
  const p = e.payload;
  const flagged = e.eventType === 'injection_flagged';
  const suspected = p.injectionSuspected === true;
  if (!flagged) return { flagged, suspected, source: null, excerpt: null };
  const holder = parsed(Record, p.input) ?? p;
  const excerpt = parsed(Text, holder.excerpt);
  return {
    flagged,
    suspected,
    source: parsed(Source, holder.source),
    excerpt: excerpt === null ? null : cut(excerpt, EXCERPT_CHARS).text,
  };
}

const shownRules = (rules: readonly RuleResult[]): GateView['ruleResults'] =>
  rules.map(({ ruleId, passed, message }) => ({ ruleId, passed, message }));

/** Rule 8: the stored gate output, copied. Anything that fails its parse is null. */
function gateOf(e: AuditEvent): GateView | null {
  if (e.eventType !== 'gate_result') return null;
  const kind = e.payload.kind;
  // The Q&A and onboarding payloads are the gate result plus `kind` and `requestId`.
  const rest = Object.fromEntries(
    Object.entries(e.payload).filter(([key]) => key !== 'kind' && key !== 'requestId'),
  );
  if (kind === 'gate_result') {
    const g = parsed(LeaveGateResult, e.payload.gate);
    return g === null
      ? null
      : {
          family: 'leave',
          verdict: g.verdict,
          policyVersion: g.policyVersion,
          ruleResults: shownRules(g.ruleResults),
        };
  }
  if (kind === 'qa_gate_result') {
    const g = parsed(QaGateResult, rest);
    return g === null
      ? null
      : {
          family: 'qa',
          verdict: g.verdict,
          policyVersion: g.policyVersion,
          ruleResults: shownRules(g.ruleResults),
        };
  }
  if (kind === 'onboarding_gate_result') {
    const g = parsed(OnboardingGateResult, rest);
    return g === null
      ? null
      : {
          family: 'onboarding',
          verdict: g.verdict,
          policyVersion: g.policyVersion,
          ruleResults: shownRules(g.ruleResults),
        };
  }
  return null;
}

/** Rule 9: the recorded decision; `comment` and `gateResultSeen` are never projected. */
function humanOf(e: AuditEvent): TimelineStep['human'] {
  if (e.eventType !== 'human_action') return null;
  const h = parsed(HumanFields, e.payload);
  return h === null
    ? null
    : {
        action: h.action,
        actorRole: h.actorRole,
        statusBefore: h.statusBefore,
        statusAfter: h.statusAfter,
      };
}

function stepOf(e: AuditEvent): TimelineStep {
  const p = e.payload;
  const tokens = TOKEN_KINDS.has(p.kind) ? parsed(StoredTokens, p.tokens) : null;
  return {
    eventId: e.id,
    at: e.at,
    eventType: e.eventType,
    actor: { kind: e.actor.kind, id: e.actor.id },
    stage: stageOf(e),
    kind: parsed(SafeToken, p.kind),
    agent: parsed(SafeToken, p.agent),
    model: parsed(SafeToken, p.model),
    promptVersion: parsed(SafeToken, p.promptVersion),
    tool: parsed(SafeToken, p.tool),
    outcome: parsed(SafeToken, p.outcome),
    isError: typeof p.isError === 'boolean' ? p.isError : null,
    tokens: tokens === null ? null : { input: tokens.input, output: tokens.output },
    latencyMs: LATENCY_KINDS.has(p.kind) ? parsed(Latency, p.latencyMs) : null,
    input: inputOf(p),
    injection: injectionOf(e),
    gate: gateOf(e),
    human: humanOf(e),
  };
}

/** Rule 5: the request's one summary event (earliest `at`, then lowest id; agent-metrics rule 17). */
function requestTotalOf(events: readonly AuditEvent[], readerIsHr: boolean): RequestTotal {
  if (!readerIsHr) return { status: 'hidden' };
  let summary: AuditEvent | null = null;
  for (const e of events) {
    if (!SUMMARY.has(e.payload.kind)) continue;
    if (summary === null) {
      summary = e;
      continue;
    }
    const t = Date.parse(e.at) - Date.parse(summary.at);
    if (t < 0 || (t === 0 && e.id < summary.id)) summary = e;
  }
  if (summary === null || !('usage' in summary.payload)) return { status: 'none' };
  if (summary.payload.usage === null) return { status: 'unpriced' };
  const usage = parsed(Usage, summary.payload.usage);
  return usage === null ? { status: 'none' } : { status: 'priced', usage };
}

export function toTimeline(
  events: readonly AuditEvent[],
  { readerIsHr }: { readerIsHr: boolean },
): Timeline {
  const steps = events.map(stepOf);
  return {
    steps,
    injectionCount: steps.filter((s) => s.injection.flagged).length,
    requestTotal: requestTotalOf(events, readerIsHr),
  };
}
