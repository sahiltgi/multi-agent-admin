// GET /handbook/sections/:id contract (spec employee-chat, rules 13, 14). Imports only zod and the
// pure handbook module, so @hr/shared can re-export the response and stay browser-safe.
import { z } from 'zod';
import { SectionId } from '../domain/handbook.js';

export const HandbookSectionParams = z.object({ id: SectionId }).strict();
export const HandbookSectionQuery = z.object({}).strict();

export const HandbookSectionResponse = z
  .object({
    id: SectionId,
    text: z.string().min(1), // body.slice(section.start, section.end) of the boot-loaded body, unchanged
  })
  .strict(); // no hash, offsets, policy data or other sections
export type HandbookSectionResponse = z.infer<typeof HandbookSectionResponse>;
