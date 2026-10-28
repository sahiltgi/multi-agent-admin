// The web's only HTTP client (spec web-shell, rules 2 and 8). Every call carries `x-demo-user`, and
// every body, success or error, is parsed with an @hr/shared schema before anything uses it.
import {
  ActionResponse,
  BuildNotesResponse,
  ChatBody,
  ChatResponse,
  ChecklistView,
  CreateOnboardingResponse,
  ErrorBody,
  EvalHistoryResponse,
  HandbookSectionResponse,
  ListApprovalsResponse,
  ListOnboardingResponse,
  MyRequestsResponse,
  TaskStatusBody,
  TraceResponse,
  TraceTimelineResponse,
} from '@hr/shared';
import type { ActionBody, CreateOnboardingBody } from '@hr/shared';
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

// spec onboarding-ui, rule 2: the method is explicit, so PATCH can carry a body like POST.
async function request<T>(
  method: 'GET' | 'POST' | 'PATCH',
  schema: Parser<T>,
  path: string,
  { employeeId, signal }: CallOptions,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-demo-user': employeeId,
  };
  const init: RequestInit = { method, headers, signal };
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
  return request('POST', ChatResponse, '/chat', opts, ChatBody.parse(input));
}

export function getApprovals(opts: CallOptions): Promise<ApiResult<ListApprovalsResponse>> {
  return request('GET', ListApprovalsResponse, '/approvals', opts);
}

// spec approval-queue-ui, rule 13: the body is built with ActionBody.parse by the caller. Never retried.
export function postAction(
  itemId: string,
  body: ActionBody,
  opts: CallOptions,
): Promise<ApiResult<ActionResponse>> {
  return request(
    'POST',
    ActionResponse,
    `/approvals/${encodeURIComponent(itemId)}/actions`,
    opts,
    body,
  );
}

export function getTrace(requestId: string, opts: CallOptions): Promise<ApiResult<TraceResponse>> {
  return request('GET', TraceResponse, `/audit/${encodeURIComponent(requestId)}`, opts);
}

// spec audit-view, rules 19 and 20: the three /audit calls. None has a query string.
export function getTimeline(
  requestId: string,
  opts: CallOptions,
): Promise<ApiResult<TraceTimelineResponse>> {
  return request(
    'GET',
    TraceTimelineResponse,
    `/audit/${encodeURIComponent(requestId)}/timeline`,
    opts,
  );
}

export function getEvalHistory(opts: CallOptions): Promise<ApiResult<EvalHistoryResponse>> {
  return request('GET', EvalHistoryResponse, '/evals/history', opts);
}

export function getBuildNotes(opts: CallOptions): Promise<ApiResult<BuildNotesResponse>> {
  return request('GET', BuildNotesResponse, '/build-notes', opts);
}

// spec employee-chat, rule 11: no query string and no employeeId; the server scopes to the actor.
export function getMyRequests(opts: CallOptions): Promise<ApiResult<MyRequestsResponse>> {
  return request('GET', MyRequestsResponse, '/my-requests', opts);
}

export function getHandbookSection(
  sectionId: string,
  opts: CallOptions,
): Promise<ApiResult<HandbookSectionResponse>> {
  return request(
    'GET',
    HandbookSectionResponse,
    `/handbook/sections/${encodeURIComponent(sectionId)}`,
    opts,
  );
}

// spec onboarding-ui, rules 2 and 7: one page of summaries; the route follows nextCursor itself.
export function getOnboardingList(
  cursor: string | null,
  opts: CallOptions,
): Promise<ApiResult<ListOnboardingResponse>> {
  const query = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return request('GET', ListOnboardingResponse, `/onboarding?limit=50${query}`, opts);
}

export function getChecklist(
  checklistId: string,
  opts: CallOptions,
): Promise<ApiResult<ChecklistView>> {
  return request('GET', ChecklistView, `/onboarding/${encodeURIComponent(checklistId)}`, opts);
}

// The body is built with CreateOnboardingBody.parse by the caller. Never retried (rule 2).
export function postOnboarding(
  body: CreateOnboardingBody,
  opts: CallOptions,
): Promise<ApiResult<CreateOnboardingResponse>> {
  return request('POST', CreateOnboardingResponse, '/onboarding', opts, body);
}

// spec onboarding-ui, rule 12: "Mark done" only; the server sets completedBy and onBehalfOf.
export function patchTaskDone(
  checklistId: string,
  taskId: string,
  opts: CallOptions,
): Promise<ApiResult<ChecklistView>> {
  return request(
    'PATCH',
    ChecklistView,
    `/onboarding/${encodeURIComponent(checklistId)}/tasks/${encodeURIComponent(taskId)}`,
    opts,
    TaskStatusBody.parse({ status: 'done' }),
  );
}
