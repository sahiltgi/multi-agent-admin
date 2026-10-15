// Seed fixtures: synthetic only (spec domain-schemas, rules 16–22).
// Plain deterministic literals. Every name, email and id here is fictional.
import {
  LEAVE_TYPES,
  type Employee,
  type Holiday,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
  type Team,
} from '../domain/schemas.js';

export interface SeedFixtures {
  teams: Team[];
  employees: Employee[];
  leaveBalances: LeaveBalance[];
  holidays: Holiday[];
  leaveRequests: LeaveRequest[];
}

export const COMPANY_NAME = 'Example Widgets Demo Co.';

const PERIOD = '2026-27';
const EMAIL_DOMAIN = 'example-widgets.example';

function person(
  id: string,
  role: Employee['role'],
  teamId: string | null,
  managerId: string | null,
): Employee {
  const label = role === 'hr_admin' ? 'HR Admin' : role === 'manager' ? 'Manager' : 'Employee';
  return {
    id,
    displayName: `Demo ${label} ${id.slice(4)}`,
    email: `${id}@${EMAIL_DOMAIN}`,
    role,
    teamId,
    managerId,
  };
}

const teams: Team[] = [
  { id: 'team-a', name: 'Demo Team A', managerId: 'emp-002' },
  { id: 'team-b', name: 'Demo Team B', managerId: 'emp-009' },
  { id: 'team-c', name: 'Demo Team C', managerId: 'emp-015' },
];

const employees: Employee[] = [
  person('emp-001', 'hr_admin', null, null),
  // team-a: 7 people, the team-overlap team (rule 22)
  person('emp-002', 'manager', 'team-a', 'emp-001'),
  person('emp-003', 'employee', 'team-a', 'emp-002'),
  person('emp-004', 'employee', 'team-a', 'emp-002'),
  person('emp-005', 'employee', 'team-a', 'emp-002'),
  person('emp-006', 'employee', 'team-a', 'emp-002'),
  person('emp-007', 'employee', 'team-a', 'emp-002'),
  person('emp-008', 'employee', 'team-a', 'emp-002'),
  // team-b
  person('emp-009', 'manager', 'team-b', 'emp-001'),
  person('emp-010', 'employee', 'team-b', 'emp-009'),
  person('emp-011', 'employee', 'team-b', 'emp-009'),
  person('emp-012', 'employee', 'team-b', 'emp-009'),
  person('emp-013', 'employee', 'team-b', 'emp-009'),
  person('emp-014', 'employee', 'team-b', 'emp-009'),
  // team-c
  person('emp-015', 'manager', 'team-c', 'emp-001'),
  person('emp-016', 'employee', 'team-c', 'emp-015'),
  person('emp-017', 'employee', 'team-c', 'emp-015'),
  person('emp-018', 'employee', 'team-c', 'emp-015'),
  person('emp-019', 'employee', 'team-c', 'emp-015'),
  person('emp-020', 'employee', 'team-c', 'emp-015'),
];

const ENTITLED_DAYS: Record<LeaveType, number> = {
  annual: 20,
  sick: 10,
  casual: 6,
  unpaid: 0,
  bereavement: 5,
  parental: 60,
};

// Used days set by hand to match the approved leaves below (not cross-checked: D-14).
const USED_DAYS: Readonly<Record<string, Partial<Record<LeaveType, number>>>> = {
  'emp-003': { annual: 5 },
  'emp-005': { annual: 3 },
  'emp-006': { annual: 3 },
  'emp-011': { sick: 2 },
  'emp-017': { casual: 0.5 },
};

const leaveBalances: LeaveBalance[] = employees.flatMap((e) =>
  LEAVE_TYPES.map((leaveType) => ({
    employeeId: e.id,
    leaveType,
    period: PERIOD,
    entitledDays: ENTITLED_DAYS[leaveType],
    usedDays: USED_DAYS[e.id]?.[leaveType] ?? 0,
  })),
);

// Fictional company calendar for 2026-27 (D-5).
const holidays: Holiday[] = [
  { date: '2026-05-01', name: 'Demo Founders Day', period: PERIOD }, // Friday
  { date: '2026-08-15', name: 'Demo Summer Saturday', period: PERIOD }, // Saturday
  { date: '2026-10-02', name: 'Demo Widget Day', period: PERIOD }, // Friday
  { date: '2026-11-18', name: 'Demo Autumn Rest Day', period: PERIOD }, // Wednesday
  { date: '2026-12-25', name: 'Demo Winter Holiday', period: PERIOD }, // Friday
  { date: '2027-01-01', name: 'Demo New Year Day', period: PERIOD }, // Friday
];

const leaveRequests: LeaveRequest[] = [
  {
    id: 'lr-001',
    employeeId: 'emp-005',
    leaveType: 'annual',
    startDate: '2026-12-07',
    endDate: '2026-12-09',
    status: 'approved',
    createdAt: '2026-11-02T09:00:00Z',
  },
  {
    // Overlaps lr-001 on 2026-12-08 and 2026-12-09 in team-a (rule 22).
    id: 'lr-002',
    employeeId: 'emp-006',
    leaveType: 'annual',
    startDate: '2026-12-08',
    endDate: '2026-12-10',
    status: 'approved',
    createdAt: '2026-11-03T09:00:00Z',
  },
  {
    id: 'lr-003',
    employeeId: 'emp-011',
    leaveType: 'sick',
    startDate: '2026-10-12',
    endDate: '2026-10-13',
    status: 'approved',
    createdAt: '2026-10-12T08:00:00Z',
  },
  {
    id: 'lr-004',
    employeeId: 'emp-017',
    leaveType: 'casual',
    startDate: '2027-02-15',
    endDate: '2027-02-15',
    endHalf: 'am',
    status: 'approved',
    createdAt: '2027-02-01T09:00:00Z',
  },
  {
    id: 'lr-005',
    employeeId: 'emp-003',
    leaveType: 'annual',
    startDate: '2026-06-15',
    endDate: '2026-06-19',
    status: 'approved',
    createdAt: '2026-05-25T09:00:00Z',
  },
];

export const fixtures: SeedFixtures = { teams, employees, leaveBalances, holidays, leaveRequests };
