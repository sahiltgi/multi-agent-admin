// Policy Q&A schemas shared by the gate, the agent, intake/chat and the approval queue
// (spec policy-qa DD-23). They live in domain/ because server/src/http/ must not import /gate/,
// the same reason LeaveGateResult lives in domain/schemas.ts.
import { z } from 'zod';
import { SectionId } from './handbook.js';
import { Id, IsoDateTime } from './schemas.js';

export { SectionId };

/** Equals agents' MAX_USER_TEXT_CHARS; domain/ can't import agents/. */
export const MAX_QUESTION_CHARS = 4000;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const QaRuleId = z.enum(['citations_present', 'citations_verbatim', 'topic_not_sensitive']);
export type QaRuleId = z.infer<typeof QaRuleId>;

/** Same shape as the domain RuleResult (request-intake D-1). */
export const QaRuleResult = z
  .object({
    ruleId: QaRuleId,
    passed: z.boolean(),
    expected: z.string().min(1),
    actual: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type QaRuleResult = z.infer<typeof QaRuleResult>;

export const QaVerdict = z.enum(['AUTO_ANSWER', 'ESCALATE_TO_HR']);
export type QaVerdict = z.infer<typeof QaVerdict>;

export const QaGateResult = z
  .object({
    verdict: QaVerdict,
    // fixed order: citations_present, citations_verbatim, topic_not_sensitive (rule 5)
    ruleResults: z.tuple([QaRuleResult, QaRuleResult, QaRuleResult]),
    reason: z.string().min(1),
    policyVersion: z.string().min(1),
    policyHash: Sha256,
    sectionIds: z.array(SectionId), // an extra field beyond the five required ones (DD-16)
  })
  .strict();
export type QaGateResult = z.infer<typeof QaGateResult>;

export const PolicyQuestionEscalation = z.enum([
  'gate',
  'stop_reason',
  'unsupported_block',
  'unsupported_citation',
  'empty_answer',
  'invalid_response',
]);
export type PolicyQuestionEscalation = z.infer<typeof PolicyQuestionEscalation>;

/** Storage-only: outside ENTITY_SCHEMAS and MODELS (rule 21; DD-20). */
export const PolicyQuestion = z
  .object({
    id: Id, // equals the turn's requestId, so the item's subjectId is also the trace id
    employeeId: Id, // the asker; never from the body or text
    question: z.string().trim().min(1).max(MAX_QUESTION_CHARS), // raw: HR needs it to reply
    draftAnswer: z.string().min(1).nullable(), // never shown to the asker
    escalation: PolicyQuestionEscalation,
    gateResult: QaGateResult.nullable(), // null when the gate didn't run
    policyVersion: z.string().min(1),
    policyHash: Sha256,
    handbookHash: Sha256,
    createdAt: IsoDateTime,
  })
  .strict();
export type PolicyQuestion = z.infer<typeof PolicyQuestion>;

export interface PolicyQuestionStore {
  /** False if the id exists; never overwrites. */
  insert(q: PolicyQuestion): Promise<boolean>;
  /** Used by the SubjectResolver (rule 23). */
  get(id: string): Promise<PolicyQuestion | null>;
  /** Compensation only (rule 22). */
  remove(id: string): Promise<void>;
}
