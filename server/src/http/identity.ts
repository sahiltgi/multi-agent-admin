// Demo identity (spec approval-queue, rules 1 and 2; ADR-0005). `x-demo-user` names a seeded
// user and is an unauthenticated MVP shortcut: it is refused in production.
import { z } from 'zod';
import { Role } from '../domain/schemas.js';
import type { EmployeeDirectory } from './approvals/ports.js';

export const DEMO_USER_HEADER = 'x-demo-user';

// Exact match: no trimming and no case folding. The domain `Id` trims, so it is not used here.
const DemoUserHeader = z.string().regex(/^[A-Za-z0-9-]+$/);

export const Actor = z.object({ employeeId: z.string().min(1), role: Role }).strict();
export type Actor = z.infer<typeof Actor>;

export class DemoIdentityRefusedError extends Error {
  constructor() {
    super('The x-demo-user identity shortcut is refused when NODE_ENV=production (ADR-0005)');
    this.name = 'DemoIdentityRefusedError';
  }
}

/** Called by whatever starts the HTTP server, before createApp. Pure: the caller passes the env. */
export function assertDemoIdentityAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') throw new DemoIdentityRefusedError();
}

/** The raw header value if it is one well-formed id, else null. A repeated header is refused. */
export function parseDemoUserHeader(raw: string | string[] | undefined): string | null {
  const parsed = DemoUserHeader.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The actor comes from the directory record only; claims elsewhere in the request are ignored. */
export async function resolveActor(
  directory: EmployeeDirectory,
  raw: string | string[] | undefined,
): Promise<Actor | null> {
  const id = parseDemoUserHeader(raw);
  if (id === null) return null;
  const employee = await directory.getById(id);
  if (employee?.id !== id) return null;
  return Actor.parse({ employeeId: employee.id, role: employee.role });
}
