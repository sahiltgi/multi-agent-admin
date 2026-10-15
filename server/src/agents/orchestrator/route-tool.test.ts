import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProductionRegistry } from '../registry.js';
import { ORCHESTRATOR_CONFIG } from './config.js';
import { createRouteTool } from './route-tool.js';
import { RouteOutput } from './schemas.js';

const routeTool = createRouteTool('Synthetic route description.');

describe('route tool', () => {
  it('AT-6: the handler echoes the label and the output parses as RouteOutput', async () => {
    const out = await routeTool.handler(
      { label: 'leave' },
      {
        requestId: 'req-1',
        agentId: 'orchestrator',
        actor: { employeeId: 'emp-004', role: 'employee' },
        signal: new AbortController().signal,
      },
    );
    expect(out).toEqual({ accepted: true, label: 'leave' });
    expect(RouteOutput.safeParse(out).success).toBe(true);
  });

  it('AT-6: the tool is named route', () => {
    expect(routeTool.name).toBe('route');
    expect(routeTool.description.length).toBeGreaterThan(0);
  });

  it('AT-6: the source has no I/O, SDK, sub-agent or clock access', () => {
    const src = readFileSync(new URL('./route-tool.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"](node:)?fs(\/promises)?['"]/);
    expect(src).not.toMatch(/mongoose|@anthropic-ai\/sdk/);
    expect(src).not.toMatch(/from\s+['"][^'"]*(leave|policy-qa|policy_qa|onboarding)[^'"]*['"]/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
  });

  it('AT-19: the production registry registers route and the allowlist reaches only route', () => {
    const registry = createProductionRegistry({ route: 'Synthetic route description.' });
    expect(registry.has('route')).toBe(true);
    const reachable = registry.names().filter((n) => ORCHESTRATOR_CONFIG.allowlist.includes(n));
    expect(reachable).toEqual(['route']);
    expect(ORCHESTRATOR_CONFIG.allowlist).toEqual(['route']);
    const forbidden =
      /approve|compens|salary|payroll|bonus|terminat|dismiss|fire_|edit_employee|update_employee/i;
    for (const name of registry.names()) expect(name).not.toMatch(forbidden);
  });
});
