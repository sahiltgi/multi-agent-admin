// Leave policy schema (spec leave-policy). Pure Zod: safe to import from the gate.
// Reading and hashing the file belong to the loader outside the gate, never here (rule 2).
import { z } from 'zod';
import { IsoDate, LEAVE_TYPES, LeaveType, type LeaveRequest } from '../domain/schemas.js';

/** LeaveRequest fields a leave type may require (D-2). */
export const REQUIRED_FIELD_NAMES = [
  'startDate',
  'endDate',
  'reason',
] as const satisfies readonly (keyof LeaveRequest)[];
export const RequiredField = z.enum(REQUIRED_FIELD_NAMES);
export type RequiredField = z.infer<typeof RequiredField>;

/** Whole working days; half days are the gate's arithmetic, not policy values. */
export const WorkingDays = z.number().int().nonnegative();

function uniqueList<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .refine((xs) => new Set(xs).size === xs.length, { error: 'entries must be unique' });
}

export const BlackoutWindow = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    start: IsoDate, // inclusive
    end: IsoDate, // inclusive
    label: z.string().trim().min(1).max(120), // data, never instructions
  })
  .strict()
  .refine((w) => w.start <= w.end, { path: ['end'], error: 'end must not be before start' });
export type BlackoutWindow = z.infer<typeof BlackoutWindow>;

export const LeavePolicyV1 = z
  .object({
    version: z.literal('v1'), // the loader also checks it matches the file name stem (rule 1)
    effectiveFrom: IsoDate, // recorded only, never compared with the current date (rule 10)
    leaveTypes: uniqueList(LeaveType),
    minNoticeWorkingDays: z.record(LeaveType, WorkingDays), // every leave type, no other keys
    requiredFields: z.record(LeaveType, uniqueList(RequiredField).min(1)),
    // Members are LeaveType values, and leaveTypes must hold every LeaveType, so this is a subset.
    alwaysEscalate: uniqueList(LeaveType),
    blackoutWindows: z.array(BlackoutWindow),
    maxTeamOverlapPercent: z.number().int().min(0).max(100), // a percentage, not a 0–1 fraction
    escalateAboveConsecutiveWorkingDays: z.number().int().min(1), // escalate above N, not at N
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.leaveTypes.length !== LEAVE_TYPES.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['leaveTypes'],
        message: `must list exactly: ${LEAVE_TYPES.join(', ')}`,
      });
    }
    const seen = new Set<string>();
    p.blackoutWindows.forEach((w, i) => {
      if (seen.has(w.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blackoutWindows', i, 'id'],
          message: 'blackout window ids must be unique',
        });
      }
      seen.add(w.id);
    });
  });
export type LeavePolicyV1 = z.infer<typeof LeavePolicyV1>;

/** Lowercase hex SHA-256 of the policy file's raw bytes. */
export const PolicyHash = z.string().regex(/^[a-f0-9]{64}$/);
export type PolicyHash = z.infer<typeof PolicyHash>;

/** What the gate receives: the parsed policy plus the version and hash it cites. */
export const LoadedLeavePolicy = z
  .object({
    policy: LeavePolicyV1,
    policyVersion: z.string().min(1),
    policyHash: PolicyHash,
  })
  .strict()
  .refine((l) => l.policyVersion === l.policy.version, {
    path: ['policyVersion'],
    error: 'policyVersion must equal policy.version',
  });
export type LoadedLeavePolicy = z.infer<typeof LoadedLeavePolicy>;
