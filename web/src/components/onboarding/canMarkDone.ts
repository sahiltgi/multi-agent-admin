// Whether "Mark done" renders for a task (spec onboarding-ui, rule 11; OQ-4). A pure UX mirror of
// onboarding-api rule 13: no clock, no I/O. The server still decides every permission.
import { taskStatus } from '@hr/shared';
import type { ChecklistView, Role } from '@hr/shared';

type Checklist = ChecklistView['checklist'];
type Task = Checklist['tasks'][number];

export function canMarkDone(
  task: Task,
  checklist: Checklist,
  persona: { employeeId: string; roleLabel: Role },
): boolean {
  if (taskStatus(task) === 'done') return false;
  switch (task.owner) {
    case 'manager':
      return persona.employeeId === checklist.managerEmployeeId;
    case 'buddy':
      return task.ownerEmployeeId === undefined
        ? persona.roleLabel === 'hr_admin'
        : persona.employeeId === task.ownerEmployeeId;
    case 'it':
    case 'admin':
      return persona.roleLabel === 'hr_admin';
  }
}
