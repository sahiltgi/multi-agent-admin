// The web's only HTTP client (spec web-shell, rules 2 and 8). Every call carries `x-demo-user`, and
// every body, success or error, is parsed with an @hr/shared schema before anything uses it.
import {
  ChatBody,
  ChatResponse,
  ErrorBody,
  ListApprovalsResponse,
  TraceResponse,
} from '@hr/shared';
import { API_BASE } from './env.js';

/** The part of an @hr/shared schema the client uses; zod is imported only in env.ts and storage.ts (rule 16). */
interface Parser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; error: ErrorBody['error'] }
  | { ok: false; kind: 'invalid_response' }
  | { ok: false; kind: 'network' }
  | { ok: false; kind: 'aborted' };

export type ApiFailure = Exclude<ApiResult<unknown>, { ok: true }>;

interface CallOptions {
  employeeId: string;
  signal: AbortSignal;
}

async function request<T>(
  schema: Parser<T>,
  path: string,
  { employeeId, signal }: CallOptions,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-demo-user': employeeId,
  };
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers, signal };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    return signal.aborted ? { ok: false, kind: 'aborted' } : { ok: false, kind: 'network' };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return signal.aborted
      ? { ok: false, kind: 'aborted' }
      : { ok: false, kind: 'invalid_response' };
  }
  if (signal.aborted) return { ok: false, kind: 'aborted' };

  if (res.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, kind: 'invalid_response' };
  }
  const error = ErrorBody.safeParse(json);
  return error.success
    ? { ok: false, kind: 'http', status: res.status, error: error.data.error }
    : { ok: false, kind: 'invalid_response' };
}

export function postChat(
  input: { message: string; conversationId?: string },
  opts: CallOptions,
): Promise<ApiResult<ChatResponse>> {
  return request(ChatResponse, '/chat', opts, ChatBody.parse(input));
}

export function getApprovals(opts: CallOptions): Promise<ApiResult<ListApprovalsResponse>> {
  return request(ListApprovalsResponse, '/approvals', opts);
}

export function getTrace(requestId: string, opts: CallOptions): Promise<ApiResult<TraceResponse>> {
  return request(TraceResponse, `/audit/${encodeURIComponent(requestId)}`, opts);
}
