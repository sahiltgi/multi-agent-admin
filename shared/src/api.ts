// @hr/shared: the HTTP contract the web uses, re-exported from the server's own Zod schemas
// (spec web-shell, rule 16, D-2). Re-exports only: nothing is declared here, and every name is
// the identical object the server module exports. The import graph stays zod-only (rule 17).
export { ChatBody, ChatResponse, ConversationView } from '../../server/src/chat/schemas.js';
export {
  ActionBody,
  ActionResponse,
  ApprovalItemView,
  ListApprovalsResponse,
  MAX_COMMENT_CHARS,
  TraceResponse,
} from '../../server/src/http/approvals/schemas.js';
export { ErrorBody, ErrorCode } from '../../server/src/http/errors.js';
export { MAX_USER_TEXT_CHARS } from '../../server/src/agents/schemas.js';
export {
  ApprovalKind,
  ApprovalStatus,
  LeaveVerdict,
  OnboardingVerdict,
  Role,
} from '../../server/src/domain/schemas.js';
export { QaVerdict, SectionId } from '../../server/src/domain/qa.js';
// spec employee-chat, rule 12: My requests and the handbook section view.
export { MyRequestsResponse } from '../../server/src/intake/schemas.js';
export { HandbookSectionResponse } from '../../server/src/handbook/schemas.js';
