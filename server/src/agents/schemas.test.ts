// specs/policy-qa.md AT-52: ModelRequest tools and tool_choice become optional together.
import { describe, expect, it } from 'vitest';
import { ModelRequest } from './schemas.js';

const TOOL = {
  name: 'get_my_balance',
  description: 'Synthetic balance.',
  input_schema: { type: 'object', additionalProperties: false },
  strict: true,
};
const base = {
  model: 'claude-sonnet-5-5',
  system: 'SYSTEM-FIXTURE',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  max_tokens: 1024,
  output_config: { effort: 'low' },
};

describe('policy-qa AT-52: ModelRequest amendment', () => {
  it('AT-52: accepts a request with tools and tool_choice, and one with neither', () => {
    expect(
      ModelRequest.safeParse({ ...base, tools: [TOOL], tool_choice: { type: 'auto' } }).success,
    ).toBe(true);
    expect(ModelRequest.safeParse(base).success).toBe(true);
  });

  it('AT-52: rejects empty tools, tool_choice without tools, and tools without tool_choice', () => {
    expect(ModelRequest.safeParse({ ...base, tools: [] }).success).toBe(false);
    expect(
      ModelRequest.safeParse({ ...base, tools: [], tool_choice: { type: 'auto' } }).success,
    ).toBe(false);
    expect(ModelRequest.safeParse({ ...base, tool_choice: { type: 'auto' } }).success).toBe(false);
    expect(ModelRequest.safeParse({ ...base, tools: [TOOL] }).success).toBe(false);
  });
});
