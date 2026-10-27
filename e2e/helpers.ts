// Shared helpers for the demo e2e suite (spec e2e-demo, rules 1, 13 and 14). Selectors use roles,
// labels and the fixed texts in web/src/texts.ts, never CSS classes or model prose.
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatResponse } from '@hr/shared';

/** Same instant as E2E_EPOCH_ISO in server/src/e2e/clock.ts (rule 6): the browser and server agree. */
export const E2E_EPOCH_ISO = '2026-11-09T09:00:00.000Z';

export type Persona = 'asha' | 'ravi' | 'meera';

const PERSONA_LABEL: Readonly<Record<Persona, RegExp>> = {
  asha: /^Asha/,
  ravi: /^Ravi/,
  meera: /^Meera/,
};

export const EMPLOYEE_ID: Readonly<Record<Persona, string>> = {
  asha: 'emp-003',
  ravi: 'emp-002',
  meera: 'emp-001',
};

/** Opens `path` as `persona`. The route is keyed by persona, so a switch remounts it. */
export async function openAs(page: Page, persona: Persona, path: string): Promise<void> {
  await page.goto(path);
  await page
    .getByRole('radiogroup', { name: 'Demo user' })
    .getByRole('radio', { name: PERSONA_LABEL[persona] })
    .check();
}

/** Sends one chat message and returns the server's requestId for that turn. */
export async function send(page: Page, text: string): Promise<string> {
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST',
  );
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  const r = await response;
  if (!r.ok()) throw new Error(`POST /chat failed with ${String(r.status())}`);
  return ChatResponse.parse(await r.json()).requestId;
}

/** The latest chat turn: the list item holding the message just sent. */
export function turnFor(page: Page, text: string) {
  return page.getByRole('listitem').filter({ hasText: text }).last();
}

/** API calls as a seeded user, through the same Vite proxy as the web. */
export function api(request: APIRequestContext, persona: Persona) {
  const headers = { 'x-demo-user': EMPLOYEE_ID[persona] };
  return {
    get: (path: string) => request.get(`/api${path}`, { headers }),
    post: (path: string, data: unknown) => request.post(`/api${path}`, { headers, data }),
  };
}

/** Loads one request's trace on /audit as Meera (hr_admin). */
export async function openTrace(page: Page, requestId: string): Promise<void> {
  await openAs(page, 'meera', '/audit');
  await page.getByRole('tab', { name: 'Trace' }).click();
  await page.getByRole('textbox', { name: 'Request id' }).fill(requestId);
  await page.getByRole('button', { name: 'Load' }).click();
}

/** Full-page screenshot into e2e/screenshots/ (rule 13; gitignored, uploaded by CI). */
export async function shot(page: Page, name: string): Promise<void> {
  if (!/^step-[1-6]-[a-z0-9-]+$/.test(name)) throw new Error(`bad screenshot name: ${name}`);
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
}
