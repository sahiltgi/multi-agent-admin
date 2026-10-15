// The orchestrator's only tool (spec orchestrator, rules 3 to 5; D-9, D-15). The handler is pure:
// no I/O, no clock, no LLM, and it dispatches nothing. It only echoes the parsed label. The
// model-facing description is loaded from prompts/orchestrator/tools/route.md by the caller.
import type { ToolDefinition } from '../registry.js';
import { RouteInput, RouteOutput } from './schemas.js';

export function createRouteTool(
  description: string,
): ToolDefinition<typeof RouteInput, typeof RouteOutput> {
  return {
    name: 'route',
    description,
    inputSchema: RouteInput,
    outputSchema: RouteOutput,
    handler: (input) => Promise.resolve({ accepted: true, label: input.label }),
  };
}
