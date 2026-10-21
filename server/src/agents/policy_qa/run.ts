// Policy Q&A Agent (spec policy-qa, rules 13-18). One model call with the cached, citation-enabled
// handbook, no tools and no tool loop. The response is parsed here at the boundary, and the only
// verdict comes from evaluateQa (HARD RULE 1). The model's confidence is never read.
import { AuditEvent } from '../../domain/schemas.js';
import type { LoadedQaPolicy } from '../../gate/qa-policy.schema.js';
import { evaluateQa } from '../../gate/qa.js';
import { redactText } from '../../lib/redact.js';
import type { AuditSink } from '../audit.js';
import type { PromptLoader } from '../prompts.js';
import { invoke, raceAbort, type Clock, type Scheduler } from '../runtime.js';
import { ModelRequest, type ModelClient } from '../schemas.js';
import { wrapUntrusted } from '../untrusted.js';
import { POLICY_QA_CONFIG } from './config.js';
import {
  CharLocationCitation,
  HandbookDocumentBlock,
  IGNORED_BLOCK_TYPES,
  PolicyQaInput,
  PolicyQaResult,
  QaGateResultPayload,
  QaInjectionPayload,
  QaModelCallPayload,
  QaModelResponse,
  QaTextBlock,
  type QaFailureReason,
} from './schemas.js';

export interface PolicyQaDeps {
  model: ModelClient;
  prompts: PromptLoader;
  audit: AuditSink;
  clock: Clock;
  scheduler: Scheduler;
  idGen: () => string;
  detectInjection: (text: string) => { flagged: boolean; reason?: string };
  handbookBody: string; // handbookBody(raw), computed once at boot (rule 1)
  handbookHash: string; // SHA-256 of the UTF-8 body
  policy: LoadedQaPolicy;
  /** Injected for tests; defaults to the real gate. */
  evaluateQa?: typeof evaluateQa;
}

const EXCERPT_CHARS = 200;

/** The sink rejected a write: the run stops with no further writes (agent-runtime D-14). */
class AuditWriteFailed extends Error {}

interface ParsedAnswer {
  answerText: string;
  citations: { citedText: string; startCharIndex: number; endCharIndex: number }[];
  failure: QaFailureReason | null;
}

/** Rule 15: thinking blocks are skipped; anything else unexpected fails closed. */
function parseAnswer(response: QaModelResponse): ParsedAnswer {
  const texts: string[] = [];
  const citations: ParsedAnswer['citations'] = [];
  let unsupportedBlock = false;
  let unsupportedCitation = false;
  for (const block of response.content) {
    if (IGNORED_BLOCK_TYPES.includes(block.type)) continue;
    const text = QaTextBlock.safeParse(block);
    if (!text.success) {
      unsupportedBlock = true;
      continue;
    }
    texts.push(text.data.text);
    for (const raw of text.data.citations ?? []) {
      const c = CharLocationCitation.safeParse(raw);
      if (!c.success) {
        unsupportedCitation = true;
        continue;
      }
      citations.push({
        citedText: c.data.cited_text,
        startCharIndex: c.data.start_char_index,
        endCharIndex: c.data.end_char_index,
      });
    }
  }
  const answerText = texts.join('');
  const failure: QaFailureReason | null = unsupportedBlock
    ? 'unsupported_block'
    : unsupportedCitation
      ? 'unsupported_citation'
      : response.stop_reason !== 'end_turn'
        ? 'stop_reason'
        : answerText.trim() === ''
          ? 'empty_answer'
          : null;
  return { answerText, citations, failure };
}

export async function runPolicyQa(
  input: PolicyQaInput,
  deps: PolicyQaDeps,
): Promise<PolicyQaResult> {
  const { requestId, question } = PolicyQaInput.parse(input);
  const gate = deps.evaluateQa ?? evaluateQa;
  const cfg = POLICY_QA_CONFIG;
  const provenance = {
    policyVersion: deps.policy.policyVersion,
    policyHash: deps.policy.policyHash,
    handbookHash: deps.handbookHash,
  };

  const prompt = await deps.prompts.load(cfg.agentId, cfg.promptVersion);
  if (!prompt.found || prompt.text.trim() === '') {
    throw new Error('policy_qa prompt file is missing or blank'); // boot checks it (rule 26)
  }

  // Rule 16: a flag is audited and changes nothing else.
  const detection = deps.detectInjection(question);
  const injectionSuspected = detection.flagged;
  const result = (r: { kind: 'failed'; reason: QaFailureReason; answerText: string | null }) =>
    PolicyQaResult.parse({ ...r, requestId, provenance, injectionSuspected });

  const write = async (
    eventType: AuditEvent['eventType'],
    actor: AuditEvent['actor'],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      const event = AuditEvent.parse({
        id: deps.idGen(),
        traceId: requestId,
        at: deps.clock.nowIso(),
        actor,
        eventType,
        payload,
      });
      await deps.audit.write(event);
    } catch {
      throw new AuditWriteFailed();
    }
  };
  const agent = { kind: 'agent' as const, id: cfg.agentId };
  const callPayload = (
    p: Omit<
      QaModelCallPayload,
      'kind' | 'requestId' | 'agent' | 'model' | 'promptVersion' | 'input'
    >,
  ) =>
    QaModelCallPayload.parse({
      kind: 'qa_model_call',
      requestId,
      agent: cfg.agentId,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      input: redactText(question),
      ...p,
    });

  let answerSoFar: string | null = null;
  try {
    if (injectionSuspected) {
      await write(
        'injection_flagged',
        agent,
        QaInjectionPayload.parse({
          kind: 'injection_flagged',
          requestId,
          agent: cfg.agentId,
          source: 'user',
          excerpt: redactText(question).slice(0, EXCERPT_CHARS),
          reason: detection.reason ?? null,
        }),
      );
    }

    // Rule 14: nothing that varies per request sits in system or the document block.
    const request = ModelRequest.parse({
      model: cfg.model,
      system: prompt.text,
      messages: [
        {
          role: 'user',
          content: [
            HandbookDocumentBlock.parse({
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: deps.handbookBody },
              title: 'Employee Handbook',
              citations: { enabled: true },
              cache_control: { type: 'ephemeral' },
            }),
            { type: 'text', text: wrapUntrusted({ source: 'user', text: question }) },
          ],
        },
      ],
      max_tokens: cfg.maxTokens,
      output_config: { effort: cfg.effort },
    });

    const start = deps.clock.nowMs();
    const deadline = start + cfg.timeoutMs;
    const controller = new AbortController();
    const cancelDeadline = deps.scheduler.setTimeout(() => {
      controller.abort();
    }, cfg.timeoutMs);
    let settled;
    try {
      settled = await raceAbort(
        invoke(() =>
          deps.model.create(request, { signal: controller.signal, timeout: cfg.timeoutMs }),
        ),
        controller.signal,
      );
    } finally {
      cancelDeadline();
    }
    const latencyMs = Math.max(0, Math.round(deps.clock.nowMs() - start));

    // Timeout or API error: model_unavailable, never a guess (chat-endpoint OD-2).
    if (settled.kind !== 'value' || deps.clock.nowMs() >= deadline) {
      await write(
        'agent_step',
        agent,
        callPayload({
          output: null,
          answerChars: 0,
          citationCount: 0,
          stopReason: null,
          tokens: null,
          latencyMs,
          isError: true,
          failure: 'model_unavailable',
        }),
      );
      return result({ kind: 'failed', reason: 'model_unavailable', answerText: null });
    }

    const parsed = QaModelResponse.safeParse(settled.value);
    if (!parsed.success) {
      await write(
        'agent_step',
        agent,
        callPayload({
          output: null,
          answerChars: 0,
          citationCount: 0,
          stopReason: null,
          tokens: null,
          latencyMs,
          isError: true,
          failure: 'invalid_response',
        }),
      );
      return result({ kind: 'failed', reason: 'invalid_response', answerText: null });
    }
    const response = parsed.data;
    const { answerText, citations, failure } = parseAnswer(response);
    answerSoFar = answerText.trim() === '' ? null : answerText;
    const tokens = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? null,
      cacheCreation: response.usage.cache_creation_input_tokens ?? null,
    };
    const common = {
      answerChars: answerText.length,
      citationCount: citations.length,
      stopReason: response.stop_reason,
      tokens,
      latencyMs,
    };

    if (failure !== null) {
      await write(
        'agent_step',
        agent,
        callPayload({ ...common, output: null, isError: true, failure }),
      );
      return result({ kind: 'failed', reason: failure, answerText: answerSoFar });
    }

    const gateResult = gate(
      { question, answerText, citations, handbookBody: deps.handbookBody },
      deps.policy,
    );
    // Rule 18: an escalated draft answer never enters the audit, which the asker can read.
    const output = gateResult.verdict === 'AUTO_ANSWER' ? redactText(answerText) : null;
    await write(
      'agent_step',
      agent,
      callPayload({ ...common, output, isError: false, failure: null }),
    );
    await write(
      'gate_result',
      { kind: 'gate', id: 'qa' },
      QaGateResultPayload.parse({ kind: 'qa_gate_result', requestId, ...gateResult }),
    );
    return PolicyQaResult.parse({
      kind: 'gated',
      requestId,
      gate: gateResult,
      answerText,
      provenance,
      injectionSuspected,
    });
  } catch (err) {
    if (err instanceof AuditWriteFailed) {
      return result({ kind: 'failed', reason: 'audit_failed', answerText: answerSoFar });
    }
    throw err;
  }
}
