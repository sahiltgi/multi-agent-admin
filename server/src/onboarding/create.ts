// POST /onboarding (spec onboarding-api, rules 2–9, 18; OQ-4 to OQ-7). Code validates the body and
// builds the checklist from the role template; the notes-mode agent only turns free-text notes into
// proposed deviations; the injected gate gives the verdict, once. Every record and event is built
// and parsed before the first write, and a failed write removes what was written (rule 7).
import { createHash } from 'node:crypto';
import {
  OnboardingGateResultPayload,
  OnboardingNotesResult,
  type OnboardingEscalation,
  type ProposedDeviation,
} from '../agents/onboarding/schemas.js';
import {
  buildTemplateChecklistTasks,
  NewJoinerProfile,
  OnboardingChecklist,
  OnboardingDeviation,
  OnboardingGateResult,
} from '../domain/onboarding.js';
import { ApprovalItem, AuditEvent, type Team } from '../domain/schemas.js';
import { HttpError } from '../http/errors.js';
import type { Actor } from '../http/identity.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { undo } from '../intake/dispatch.js';
import { requestUsage } from '../metrics/usage.js';
import type { OnboardingRouteDeps } from './ports.js';
import {
  CreateOnboardingBody,
  CreateOnboardingResponse,
  EmptyQuery,
  NoParams,
  OnboardingCreatedPayload,
  OnboardingCreateEscalatedPayload,
  type CreateEscalation,
} from './schemas.js';

/** A 400 naming one body field and a fixed code; never the value (approval-queue rule 3). */
const invalid = (field: string, code: string): HttpError =>
  new HttpError('invalid_request', [{ path: ['body', field], code }]);

/** sha256 of the body without its key, keys sorted: a fingerprint, never the body (rule 8). */
function fingerprint(body: CreateOnboardingBody): string {
  const fields = Object.entries(body)
    .filter(([k, v]) => k !== 'idempotencyKey' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** Rules 2 and 3: the team, who may create, the manager, the buddy and the date. Writes nothing. */
async function validate(
  deps: OnboardingRouteDeps,
  actor: Actor,
  body: CreateOnboardingBody,
): Promise<{ team: Team; buddyEmployeeId: string | null }> {
  const team = await deps.directory.getTeamById(body.newHireTeam);
  if (team === null) throw invalid('newHireTeam', 'unknown_team');
  // OQ-6: hr_admin for any team; a manager only for the team they manage.
  const mayCreate =
    actor.role === 'hr_admin' || (actor.role === 'manager' && team.managerId === actor.employeeId);
  if (!mayCreate) throw new HttpError('forbidden');
  // OQ-7: the manager is always the team's; a mismatch is refused, never re-assigned.
  if (body.managerEmployeeId !== team.managerId) {
    throw invalid('managerEmployeeId', 'not_team_manager');
  }
  if (body.buddyEmployeeId !== null) {
    const buddy = await deps.directory.getById(body.buddyEmployeeId);
    // onboarding OQ-7: a member of the new joiner's team and not its manager.
    if (buddy?.teamId !== team.id || buddy.id === team.managerId) {
      throw invalid('buddyEmployeeId', 'invalid_buddy');
    }
  }
  if (body.startDate < deps.toIsoDate(deps.clock.nowIso())) {
    throw invalid('startDate', 'start_date_past');
  }
  return { team, buddyEmployeeId: body.buddyEmployeeId };
}

export function createCreateRoute(deps: OnboardingRouteDeps): RouteDefinition {
  const event = (
    requestId: string,
    actor: AuditEvent['actor'],
    eventType: AuditEvent['eventType'],
    payload: Record<string, unknown>,
  ): AuditEvent =>
    AuditEvent.parse({
      id: deps.idGen(),
      traceId: requestId,
      at: deps.clock.nowIso(),
      actor,
      eventType,
      payload,
    });

  /** Rule 6: nothing lands; the reply is the intake escalated text plus ids. */
  async function escalate(
    actor: Actor,
    requestId: string,
    reason: CreateEscalation,
    agentReason: OnboardingEscalation | null,
  ): Promise<CreateOnboardingResponse> {
    const text = await deps.intakeTexts.load('escalated');
    if (text === null) throw new HttpError('internal_error'); // fail closed (onboarding ID-6)
    // spec agent-metrics, rules 7, 8: whatever the notes agent spent before the escalation.
    const usage = await requestUsage(deps.auditReader, deps.pricing, [requestId]);
    const response = CreateOnboardingResponse.parse({
      kind: 'escalated',
      requestId,
      reason,
      agentReason,
      text,
    });
    const escalated = event(requestId, { kind: 'system', id: 'onboarding-api' }, 'agent_step', {
      ...OnboardingCreateEscalatedPayload.parse({
        kind: 'onboarding_create_escalated',
        requestId,
        reason,
        agentReason,
        actorRole: actor.role,
        usage,
      }),
    });
    try {
      await deps.audit.write(escalated);
    } catch {
      throw new HttpError('internal_error');
    }
    return response;
  }

  /** Rule 4: the proposals, or the escalation the route replies with. Never a verdict. */
  async function proposalsFor(
    actor: Actor,
    requestId: string,
    body: CreateOnboardingBody,
    tasks: OnboardingChecklist['tasks'],
  ): Promise<ProposedDeviation[] | CreateOnboardingResponse> {
    const notes = body.notes?.trim() ?? '';
    if (notes === '') return []; // absent or blank notes: no model call
    let raw: unknown;
    try {
      raw = await deps.runOnboardingNotes(
        {
          requestId,
          actor: { employeeId: actor.employeeId, role: actor.role },
          templateId: body.templateId,
          notes,
        },
        tasks,
      );
    } catch {
      return escalate(actor, requestId, 'agent_error', null);
    }
    const parsed = OnboardingNotesResult.safeParse(raw);
    if (!parsed.success) return escalate(actor, requestId, 'invalid_agent_output', null);
    const result = parsed.data;
    if (result.requestId !== requestId) {
      return escalate(actor, requestId, 'request_id_mismatch', null);
    }
    switch (result.kind) {
      case 'proposals':
        return result.deviations;
      case 'needs_details':
        return escalate(actor, requestId, 'needs_details', null);
      case 'escalated':
        // agent-runtime D-14: after a sink failure nothing more is written.
        if (result.reason === 'audit_failed') throw new HttpError('internal_error');
        return escalate(actor, requestId, 'agent_escalated', result.reason);
    }
  }

  async function create(
    actor: Actor,
    body: CreateOnboardingBody,
    team: Team,
    buddyEmployeeId: string | null,
  ): Promise<CreateOnboardingResponse> {
    const requestId = deps.idGen();
    // onboarding ID-4: both fixed replies are loaded before anything is written or run.
    const texts = {
      created: await deps.onboardingTexts.load('created'),
      pending_manager: await deps.onboardingTexts.load('pending_manager'),
    };
    if (texts.created === null || texts.pending_manager === null) {
      throw new HttpError('internal_error');
    }
    const hasNotes = (body.notes?.trim() ?? '') !== '';
    // Rule 18: the creator can read the trace. Recorded before the agent runs; with no notes, just
    // before the first write, so a refused create leaves nothing behind.
    const recordOwner = () => deps.messages.recordMessage(requestId, actor.employeeId);
    if (hasNotes) await recordOwner();
    const assignees = { managerEmployeeId: team.managerId, buddyEmployeeId };
    const template = deps.policy.policy.templates[body.templateId];
    const tasks = buildTemplateChecklistTasks(template, body.startDate, assignees);

    const proposals = await proposalsFor(actor, requestId, body, tasks);
    if (!Array.isArray(proposals)) return proposals;
    // spec agent-metrics, rule 7: after the last agent run; 0/0 when no notes ran the agent.
    const usage = await requestUsage(deps.auditReader, deps.pricing, [requestId]);

    // Rule 5: one gate call with the code-built input; rationales, notes and the name never reach it.
    const gateOut = OnboardingGateResult.safeParse(
      deps.evaluateOnboarding(
        {
          templateId: body.templateId,
          startDate: body.startDate,
          assignees,
          checklistTasks: tasks,
          deviations: proposals.map((p) => p.change),
        },
        deps.policy,
      ),
    );
    if (!gateOut.success) throw new HttpError('internal_error');
    const gate = gateOut.data;
    // onboarding rule 16 (OQ-13): a checklist that differs from the template is a code fault, and
    // AUTO never carries a deviation.
    const matchesTemplate = gate.ruleResults.find((r) => r.ruleId === 'checklist_matches_template');
    if (matchesTemplate?.passed !== true) throw new HttpError('internal_error');
    if ((gate.verdict === 'AUTO') !== (proposals.length === 0)) {
      throw new HttpError('internal_error');
    }
    const text = proposals.length === 0 ? texts.created : texts.pending_manager;

    // ---- build and parse every record and event before any write (rule 7) ----
    const createdAt = deps.clock.nowIso();
    const checklist = OnboardingChecklist.parse({
      id: deps.idGen(),
      requestId,
      newJoinerId: deps.idGen(),
      templateId: body.templateId,
      templateVersion: gate.policyVersion,
      policyHash: gate.policyHash,
      startDate: body.startDate,
      newHireTeam: team.id,
      managerEmployeeId: team.managerId,
      buddyEmployeeId,
      createdBy: actor.employeeId,
      tasks, // exactly the template (onboarding rules 20, 21)
      removedTemplateTaskIds: [],
      gateResult: gate,
      version: 0,
      createdAt,
    });
    const profile = NewJoinerProfile.parse({
      newJoinerId: checklist.newJoinerId,
      checklistId: checklist.id,
      displayName: body.newJoinerName,
      createdAt,
    });
    // OQ-6: a manager never decides their own proposal; hr_admin (a non-proposer) does instead.
    const proposerIsManager = actor.employeeId === checklist.managerEmployeeId;
    const deviations = proposals.map((p) =>
      OnboardingDeviation.parse({
        id: deps.idGen(),
        checklistId: checklist.id,
        requestId,
        change: p.change,
        rationale: p.rationale,
        status: 'pending',
        gateResult: gate,
        proposedBy: actor.employeeId,
        createdAt,
      }),
    );
    const items = deviations.map((d) =>
      ApprovalItem.parse({
        id: deps.idGen(),
        kind: 'onboarding_deviation',
        subjectId: d.id,
        ...(proposerIsManager
          ? { assigneeRole: 'hr_admin' }
          : { assigneeRole: 'manager', assigneeId: checklist.managerEmployeeId }),
        flagged: false,
        status: 'open',
        createdAt,
      }),
    );
    const gateEvent = event(requestId, { kind: 'gate', id: 'onboarding' }, 'gate_result', {
      ...OnboardingGateResultPayload.parse({ kind: 'onboarding_gate_result', requestId, ...gate }),
    });
    const createdEvent = event(requestId, { kind: 'human', id: actor.employeeId }, 'human_action', {
      ...OnboardingCreatedPayload.parse({
        kind: 'onboarding_created',
        requestId,
        checklistId: checklist.id,
        templateId: checklist.templateId,
        newHireTeam: checklist.newHireTeam,
        verdict: gate.verdict,
        pendingDeviations: deviations.length,
        notesProvided: hasNotes,
        agentRan: hasNotes,
        actorRole: actor.role,
        source: 'api',
        usage,
      }),
    });
    const response = CreateOnboardingResponse.parse({
      kind: 'checklist_created',
      requestId,
      checklistId: checklist.id,
      verdict: gate.verdict,
      pendingDeviationIds: deviations.map((d) => d.id),
      text,
    });

    // ---- writes: gate event, profile, checklist, deviations, items, onboarding_created ----
    if (!hasNotes) await recordOwner();
    try {
      await deps.audit.write(gateEvent);
    } catch {
      throw new HttpError('internal_error'); // nothing more is written
    }
    const undos: (() => Promise<void>)[] = [];
    const ok = async (step: () => Promise<boolean>, compensate: () => Promise<void>) => {
      // A rejected insert counts the same as a refused one.
      if (!(await step().catch(() => false))) return false;
      undos.push(compensate);
      return true;
    };
    let written =
      (await ok(
        () => deps.onboarding.insertProfile(profile),
        () => deps.onboarding.removeProfile(profile.newJoinerId),
      )) &&
      (await ok(
        () => deps.onboarding.insertChecklist(checklist),
        () => deps.onboarding.removeChecklist(checklist.id),
      ));
    for (const d of deviations) {
      written =
        written &&
        (await ok(
          () => deps.onboarding.insertDeviation(d),
          () => deps.onboarding.removeDeviation(d.id),
        ));
    }
    for (const item of items) {
      written =
        written &&
        (await ok(
          () => deps.approvals.insert(item),
          () => deps.approvals.remove(item.id),
        ));
    }
    if (written) {
      written = await deps.audit.write(createdEvent).then(
        () => true,
        () => false,
      );
    }
    if (!written) {
      // Reverse order: items, deviations, checklist, profile. The gate event stays as a trace.
      for (const step of [...undos].reverse()) await undo(step);
      throw new HttpError('internal_error');
    }
    return response;
  }

  return defineRoute({
    method: 'post',
    path: '/onboarding',
    params: NoParams,
    query: EmptyQuery,
    body: CreateOnboardingBody,
    response: CreateOnboardingResponse,
    handler: async ({ actor, body }) => {
      const { team, buddyEmployeeId } = await validate(deps, actor, body);
      const key = body.idempotencyKey;
      if (key === undefined) return create(actor, body, team, buddyEmployeeId);
      const claim = await deps.idempotency.begin(
        actor.employeeId,
        key,
        fingerprint(body),
        deps.clock.nowIso(),
      );
      if (claim.kind === 'conflict') throw new HttpError('idempotency_conflict');
      if (claim.kind === 'replay') return CreateOnboardingResponse.parse(claim.body);
      try {
        const out = await create(actor, body, team, buddyEmployeeId);
        if (out.kind === 'escalated' && out.agentReason === 'model_unavailable') {
          await deps.idempotency.release(actor.employeeId, key); // a retry runs the agent again
        } else {
          // Committed: a failed completion keeps the key claimed, so a retry can't duplicate.
          await deps.idempotency.complete(actor.employeeId, key, 200, out).catch(() => undefined);
        }
        return out;
      } catch (err) {
        // A 500 is never replayed; a failed release must not hide the original error.
        await deps.idempotency.release(actor.employeeId, key).catch(() => undefined);
        throw err;
      }
    },
  });
}
