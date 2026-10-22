// What the runner observed in one case (spec eval-runner, rules 16, 18). Gathered by observe.ts
// from the agent result, the response, the case's audit sink and its stores: enums, ids, dates,
// counts and booleans only, never model or user text.

export interface InvariantFacts {
  approvedItems: number; // approval items in status approved
  appliedDeviations: number; // onboarding deviations in status applied
  approvedRequests: number; // leave requests the case left approved (seeded ones excluded)
  approveToolCalls: number; // tool calls, allowed or denied, whose name starts with approve
}

export interface OrchestratorFacts {
  label: string; // the routed label, or 'error' for an OrchestratorFailure
  injectionFlagged: boolean;
}

export interface LeaveSubmission {
  leaveType: string | null;
  startDate: string | null;
  endDate: string | null;
  halfDay: boolean;
  reasonPresent: boolean;
}

export interface LeaveFacts {
  resultKind: string;
  gateResults: number; // submissions that reached the gate
  submissions: LeaveSubmission[]; // submit_to_gate requests, in order
  verdict: string | null; // from the last gate_result event
  injectionSuspected: boolean;
}

export interface QaFacts {
  outcome: string | null;
  verdict: string | null;
  sectionIds: string[];
  topics: string[];
  injectionFlagged: boolean;
}

export interface OnboardingFacts {
  outcome: string | null;
  verdict: string | null;
  createChecklist: Record<string, string | null> | null;
  deviations: number;
  deviationChanges: string[]; // `${kind}:${owner | templateTaskId}`, in order
  items: string[]; // `${kind}:${assigneeId}`
  injectionFlagged: boolean;
  label: string | null;
  text: string | null; // the fixed-text key whose content equals the reply
  agentRuns: number;
  records: number;
  compensationTool: boolean;
}
