// Spec gemini-fallback: AT-27 (replay key bullet). The literal was computed before the feature
// existed; any later change to what the replay key hashes for a Claude leave request breaks it.
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../agents/schemas.js';
import { replayKey } from './replay-model.js';

describe('AT-27: replay key is unchanged by the feature', () => {
  it('AT-27: the replay key of a leave request on claude-sonnet-5-5 equals the pre-feature literal', () => {
    const req = {
      model: 'claude-sonnet-5-5',
      system: 'LEAVE-PROMPT-V1 data only.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<untrusted_data source="user">\nAnnual leave 2026-11-16 to 2026-11-17\n</untrusted_data>',
            },
          ],
        },
      ],
      max_tokens: 1024,
      output_config: { effort: 'low' },
    } as unknown as ModelRequest;
    expect(replayKey(req)).toBe('8c5d67752cb8c95e3107757e18077912befbf067099484a5aa0d5319539a9cdf');
  });
});
