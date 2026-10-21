// RBAC for the approval queue (spec approval-queue, rules 5, 6, 7 and 14). Pure functions over
// already-resolved data; ownership always comes from the server-side SubjectResolver.
import type { ApprovalItem, Employee } from '../../domain/schemas.js';
import type { Actor } from '../identity.js';

export interface ItemContext {
  item: ApprovalItem;
  /** The subject owner; null when the subject can't be resolved (fail closed). */
  owner: Employee | null;
}

function assigneeMatches(item: ApprovalItem, actor: Actor): boolean {
  return item.assigneeId === undefined || item.assigneeId === actor.employeeId;
}

/** Rule 5: the manager-assignee or hr_admin-assignee grant. */
export function isAssignee(actor: Actor, { item, owner }: ItemContext): boolean {
  if (!assigneeMatches(item, actor)) return false;
  if (actor.role === 'manager') {
    // spec onboarding OQ-10: a new joiner has no directory entry, so a deviation item goes to the
    // manager it names. Every other kind uses the subject owner's manager.
    if (item.kind === 'onboarding_deviation') {
      return item.assigneeRole === 'manager' && item.assigneeId === actor.employeeId;
    }
    return (
      item.assigneeRole === 'manager' && owner !== null && owner.managerId === actor.employeeId
    );
  }
  if (actor.role === 'hr_admin') return item.assigneeRole === 'hr_admin';
  return false;
}

/** Rule 7: the actor owns the subject. */
export function isOwner(actor: Actor, { owner }: ItemContext): boolean {
  return owner !== null && owner.id === actor.employeeId;
}

/**
 * Rule 5: own (read-only) or assignee. The own grant doesn't apply to escalation items, so an
 * asker never sees their escalated question's item (spec policy-qa, rule 23). isOwner itself is
 * unchanged, so actDenial still refuses an hr_admin acting on their own question (AT-49).
 */
export function canSee(actor: Actor, ctx: ItemContext): boolean {
  const own = ctx.item.kind !== 'escalation' && isOwner(actor, ctx);
  return own || isAssignee(actor, ctx);
}

export type ActDenial = 'forbidden' | 'self_action_forbidden';

/** Rule 6 steps 4–6, for an item the actor can see. null means the actor may act. */
export function actDenial(actor: Actor, ctx: ItemContext): ActDenial | null {
  if (actor.role === 'employee') return 'forbidden';
  if (isOwner(actor, ctx)) return 'self_action_forbidden';
  if (!isAssignee(actor, ctx)) return 'forbidden';
  return null;
}

/**
 * Rule 14: hr_admin reads any trace, the owner reads theirs, a manager their direct reports'
 * leave-request traces. A trace with no LeaveRequest (a policy question, a refused message) is
 * the sender's and hr_admin's only, since it may be about the manager (request-intake D-9).
 */
export function canReadTrace(actor: Actor, owner: Employee | null, isLeave: boolean): boolean {
  if (actor.role === 'hr_admin') return true;
  if (owner === null) return false;
  if (owner.id === actor.employeeId) return true;
  return isLeave && actor.role === 'manager' && owner.managerId === actor.employeeId;
}
