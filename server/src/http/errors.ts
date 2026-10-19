// HTTP error contract (spec approval-queue, rule 3). Every error body parses as ErrorBody, and
// its message is fixed text per code: it never echoes request values or exception text.
import { z } from 'zod';

export const ErrorCode = z.enum([
  'unauthenticated',
  'invalid_request',
  'comment_required',
  'forbidden',
  'self_action_forbidden',
  'not_found',
  'already_decided',
  'gate_result_changed',
  'gate_result_missing',
  'idempotency_conflict', // request-intake D-11
  'conversation_conflict', // chat-endpoint D-4
  'conversation_full', // chat-endpoint D-7
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorIssue = z
  .object({ path: z.array(z.union([z.string(), z.number()])), code: z.string() })
  .strict();
export type ErrorIssue = z.infer<typeof ErrorIssue>;

export const ErrorBody = z
  .object({
    error: z
      .object({
        code: ErrorCode,
        message: z.string().min(1),
        issues: z.array(ErrorIssue).optional(), // invalid_request only; paths and codes, never values
      })
      .strict(),
  })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBody>;

const ERRORS: Record<ErrorCode, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: 'Unknown or missing demo user.' },
  invalid_request: { status: 400, message: 'The request is invalid.' },
  comment_required: { status: 400, message: 'A comment is required for this action.' },
  forbidden: { status: 403, message: 'You may not perform this action.' },
  self_action_forbidden: { status: 403, message: 'You may not act on your own request.' },
  not_found: { status: 404, message: 'Not found.' },
  already_decided: { status: 409, message: 'This item has already been decided.' },
  gate_result_changed: { status: 409, message: 'The gate result has changed since you saw it.' },
  gate_result_missing: { status: 409, message: 'This item has no gate result to decide on.' },
  idempotency_conflict: {
    status: 409,
    message: 'This idempotency key was already used for a different or unfinished message.',
  },
  conversation_conflict: {
    status: 409,
    message:
      'This conversation changed while your message was being handled. Please reload and try again.',
  },
  conversation_full: { status: 409, message: 'This conversation is full. Please start a new one.' },
  internal_error: { status: 500, message: 'Something went wrong.' },
};

/** Thrown by routes and middleware; the error middleware turns it into an ErrorBody. */
export class HttpError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly issues?: ErrorIssue[],
  ) {
    super(code);
    this.name = 'HttpError';
    this.status = ERRORS[code].status;
  }
}

export function errorBody(code: ErrorCode, issues?: ErrorIssue[]): ErrorBody {
  return ErrorBody.parse({
    error: {
      code,
      message: ERRORS[code].message,
      ...(issues === undefined ? {} : { issues }),
    },
  });
}

/** Zod issues reduced to paths and codes, so no input value reaches the response. */
export function toIssues(error: z.ZodError): ErrorIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
    code: i.code,
  }));
}
