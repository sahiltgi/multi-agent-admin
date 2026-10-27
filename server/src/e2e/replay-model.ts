// Replay ModelClient for the e2e server (spec e2e-demo, rules 2 and 3). Every call is answered
// from e2e/recordings/<key>.json. A miss throws; there is no network fallback.
import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ModelResponse, type ModelClient, type ModelRequest } from '../agents/schemas.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const AgentHint = z
  .object({
    model: z.string().min(1),
    systemSha256: Sha256, // never the system text
  })
  .strict();
export type AgentHint = z.infer<typeof AgentHint>;

/** No request, messages, headers, env or key material (rule 5). */
export const Recording = z
  .object({
    key: Sha256,
    agentHint: AgentHint,
    response: ModelResponse,
  })
  .strict();
export type Recording = z.infer<typeof Recording>;

export class ReplayMissError extends Error {
  constructor(key: string, hint: AgentHint) {
    super(
      `no recording for key ${key} (${hint.model}, system ${hint.systemSha256}); run npm run e2e:record`,
    );
    this.name = 'ReplayMissError';
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})/g;

/** UUIDs and ISO datetimes vary per run; plain dates are kept because the clock date is fixed. */
function normalise(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(UUID, '<id>').replace(ISO_DATETIME, '<ts>');
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

/** Object keys sorted at every depth, arrays in order, no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function replayKey(req: ModelRequest): string {
  return sha256(canonicalJson(normalise(req)));
}

export function agentHintOf(req: ModelRequest): AgentHint {
  return { model: req.model, systemSha256: sha256(req.system) };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await fsReadFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export interface ReplayDeps {
  /** Resolves null when the file is missing. */
  readFile?: (path: string) => Promise<string | null>;
}

export function createReplayModel(dir: string, deps: ReplayDeps = {}): ModelClient {
  const read = deps.readFile ?? readIfPresent;
  return {
    async create(req, opts) {
      opts.signal.throwIfAborted();
      const key = replayKey(req);
      const file = join(dir, `${key}.json`);
      const text = await read(file);
      if (text === null) throw new ReplayMissError(key, agentHintOf(req));

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`recording ${file} is not valid JSON`);
      }
      const parsed = Recording.safeParse(json);
      if (!parsed.success) throw new Error(`recording ${file} failed validation`);
      if (parsed.data.key !== key) throw new Error(`recording ${file} holds a different key`);
      return structuredClone(parsed.data.response);
    },
  };
}
