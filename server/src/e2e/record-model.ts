// Recording ModelClient, owner only (spec e2e-demo, rule 5). Wraps the real client and writes
// { key, agentHint, response } per call. Request text, headers and keys are never written.
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ModelResponse, type ModelClient } from '../agents/schemas.js';
import { agentHintOf, Recording, replayKey } from './replay-model.js';

async function writeWithDir(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, text, 'utf8');
}

export interface RecordDeps {
  writeFile?: (path: string, text: string) => Promise<void>;
}

export function createRecordingModel(
  inner: ModelClient,
  dir: string,
  deps: RecordDeps = {},
): ModelClient {
  const write = deps.writeFile ?? writeWithDir;
  return {
    async create(req, opts) {
      // Keyed on the request as sent, before anything downstream can touch it.
      const key = replayKey(req);
      const agentHint = agentHintOf(req);
      const response = await inner.create(req, opts);
      // An invalid response is passed through unrecorded; the runtime reports it as in production.
      const parsed = ModelResponse.safeParse(response);
      if (!parsed.success) return response;
      const recording = Recording.parse({ key, agentHint, response });
      await write(join(dir, `${key}.json`), `${JSON.stringify(recording, null, 2)}\n`);
      return response;
    },
  };
}
