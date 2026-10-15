// Tool registry (spec agent-runtime, rules 10, 12, 15; D-2). Handlers plug in here; the runtime
// shows the model only the tools on its agent's allowlist and enforces that list in code.
import { z } from 'zod';
import type { Role } from '../domain/schemas.js';
import { createRouteTool } from './orchestrator/route-tool.js';
import { ToolName, ToolSpec, type AgentId } from './schemas.js';
import type { ToolDescriptions } from './tool-descriptions.js';

/** Built by the runtime. Identity and role never come from model-supplied tool input (rule 15). */
export interface ToolContext {
  requestId: string;
  agentId: AgentId;
  actor: { employeeId: string; role: Role };
  signal: AbortSignal; // the run-wide signal (rule 7)
}

/**
 * A tool the runtime can run. Handlers must have no side effects: they read data or compute, and
 * code persists anything after the run, from RunResult (rule 15, D-18). A handler can outlive a
 * timed-out run if it ignores ctx.signal, and its late result is discarded, which is only safe
 * because of this contract. Input schemas may not carry identity keys (isIdentityKey).
 */
export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: I; // must be .strict(): sent with additionalProperties: false
  outputSchema: O; // handler output is parsed, never coerced (rule 13)
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<unknown>;
}

export type ParsedToolInput =
  | { ok: true; run: (ctx: ToolContext) => Promise<unknown> }
  | { ok: false; issues: readonly z.core.$ZodIssue[] };

/** Type-erased registry entry: the parsed input stays typed inside the closure. */
export interface RegisteredTool {
  readonly name: string;
  readonly spec: ToolSpec;
  readonly outputSchema: z.ZodType;
  parseInput(raw: unknown): ParsedToolInput;
}

const COMBINATORS = ['anyOf', 'oneOf', 'allOf'] as const;

/**
 * Rule 15: identity comes from ToolContext only, so no tool input may carry these keys. Compared
 * after lowercasing and removing '_' and '-', so employee_id, employeeID and EmployeeId all match.
 * An explicit target such as newHireId is allowed; its handler authorises it against ctx.actor.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'employeeid',
  'userid',
  'requesterid',
  'actorid',
  'actor',
  'role',
  'teamid',
  'managerid',
  // Parent keys too, so a nested { id } under them can't name a person.
  'employee',
  'user',
  'requester',
]);
const isIdentityKey = (key: string): boolean =>
  IDENTITY_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));

/**
 * D-2: every schema node is typed (or a combinator, enum, const or $ref), and every object has
 * additionalProperties: false. Rejects nested z.unknown() / z.any(), which become {}.
 */
function isStrictSchema(node: unknown): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  const rec = node as Record<string, unknown>;
  const typed =
    'type' in rec ||
    'enum' in rec ||
    'const' in rec ||
    '$ref' in rec ||
    COMBINATORS.some((k) => k in rec);
  if (!typed) return false;
  const types = Array.isArray(rec.type) ? rec.type : [rec.type];
  if (types.includes('object') && rec.additionalProperties !== false) return false;
  const children: unknown[] = [];
  for (const key of ['properties', '$defs'] as const) {
    const map = rec[key];
    if (typeof map !== 'object' || map === null) continue;
    if (key === 'properties' && Object.keys(map).some(isIdentityKey)) return false;
    children.push(...Object.values(map as Record<string, unknown>));
  }
  for (const key of ['prefixItems', ...COMBINATORS] as const) {
    const list = rec[key];
    if (Array.isArray(list)) children.push(...(list as unknown[]));
  }
  if (rec.items !== undefined) children.push(rec.items);
  return children.every(isStrictSchema);
}

function toInputSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: 'input' }) };
  delete json.$schema;
  if (json.type !== 'object' || !isStrictSchema(json)) {
    throw new Error(
      `Tool ${name}: inputSchema must be a .strict() object with every nested field typed and strict, and no identity keys`,
    );
  }
  return json;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): void {
    const name = ToolName.parse(def.name);
    if (this.#tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    // A tool_result must be a JSON string, and JSON.stringify(undefined) isn't one.
    if (def.outputSchema.safeParse(undefined).success) {
      throw new Error(`Tool ${name}: outputSchema must not accept undefined`);
    }
    const spec = ToolSpec.parse({
      name,
      description: def.description,
      input_schema: toInputSchema(name, def.inputSchema),
      strict: true,
    });
    this.#tools.set(name, {
      name,
      spec,
      outputSchema: def.outputSchema,
      parseInput(raw) {
        const parsed = def.inputSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, issues: parsed.error.issues };
        return { ok: true, run: (ctx) => def.handler(parsed.data, ctx) };
      },
    });
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  specFor(name: string): ToolSpec {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new Error(`Tool ${name} is not registered`);
    return tool.spec;
  }
}

/**
 * The registry the server uses. Tool handlers are added by the agent specs; their descriptions
 * come from loadToolDescriptions (prompts/, D-15). Never register an approval, compensation,
 * termination or other-employee-edit tool here (HARD RULE 2, AT-20). Tools that import other
 * modules, such as the leave tools (which use the gate's schemas), are built by the caller and
 * passed in as `extraTools`, so this module and the orchestrator that imports it never reach the
 * gate (orchestrator AT-18; spec leave-agent, D-21).
 */
export function createProductionRegistry(
  descriptions: ToolDescriptions,
  extraTools: readonly ToolDefinition<z.ZodType, z.ZodType>[] = [],
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createRouteTool(descriptions.route)); // spec orchestrator, rule 14; D-15
  for (const tool of extraTools) registry.register(tool);
  return registry;
}
