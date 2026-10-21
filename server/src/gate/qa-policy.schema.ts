// QA policy schema (spec policy-qa, rule 3). Validates policies/qa/v1.yaml; any change here or
// to the YAML must change tests or evals in the same commit (HARD RULE 5).
import { z } from 'zod';

export const SENSITIVE_TOPICS = [
  'harassment',
  'medical',
  'disciplinary',
  'compensation',
  'legal',
] as const;
export const SensitiveTopic = z.enum(SENSITIVE_TOPICS);
export type SensitiveTopic = z.infer<typeof SensitiveTopic>;

/** Lowercase words joined by single spaces, apostrophes or hyphens; no regex metacharacters. */
const KeywordPhrase = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]+(?:[ '-][a-z0-9]+)*$/);

const KeywordList = z
  .array(KeywordPhrase)
  .min(1)
  .refine((l) => new Set(l).size === l.length, { error: 'duplicate keyword phrase' });

export const QaPolicyV1 = z
  .object({
    version: z.literal('v1'),
    sensitiveTopics: z
      .object({
        harassment: KeywordList,
        medical: KeywordList,
        disciplinary: KeywordList,
        compensation: KeywordList,
        legal: KeywordList,
      })
      .strict(), // exactly the five topics
  })
  .strict();
export type QaPolicyV1 = z.infer<typeof QaPolicyV1>;

export const LoadedQaPolicy = z
  .object({
    policy: QaPolicyV1,
    policyVersion: z.string().min(1),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((l) => l.policyVersion === l.policy.version, {
    path: ['policyVersion'],
    error: 'policyVersion must equal policy.version',
  });
export type LoadedQaPolicy = z.infer<typeof LoadedQaPolicy>;
