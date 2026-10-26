// API base URL (spec web-shell, rule 7). VITE_API_BASE is non-secret and the only env value read.
import { z } from 'zod';

export const WebEnv = z.object({ VITE_API_BASE: z.string().optional() });
export type WebEnv = z.infer<typeof WebEnv>;

const DEFAULT_API_BASE = '/api';

/** Missing or empty gives `/api`; one trailing `/` is stripped. */
export function resolveApiBase(env: WebEnv): string {
  const raw = env.VITE_API_BASE;
  if (raw === undefined || raw === '') return DEFAULT_API_BASE;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export const API_BASE = resolveApiBase(
  WebEnv.parse({ VITE_API_BASE: import.meta.env.VITE_API_BASE }),
);
