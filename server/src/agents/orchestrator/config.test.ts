import { describe, expect, it } from 'vitest';
import { AgentConfig } from '../schemas.js';
import { ORCHESTRATOR_CONFIG } from './config.js';

describe('orchestrator config', () => {
  it('AT-2: parses with AgentConfig and carries the orchestrator values', () => {
    const cfg = AgentConfig.parse(ORCHESTRATOR_CONFIG);
    expect(cfg.agentId).toBe('orchestrator');
    expect(cfg.promptVersion).toBe('v1');
    expect(cfg.allowlist).toEqual(['route']);
    expect(cfg.model).toBe('claude-haiku-5-5');
  });

  it('AT-2: carries the D-1 and D-9 values', () => {
    expect(ORCHESTRATOR_CONFIG).toMatchObject({
      effort: 'low',
      maxTokens: 1024,
      timeoutMs: 30000,
      maxTurns: 3,
    });
  });

  it('AT-2: isOrchestratorConfig is true for the config and false for a widened allowlist', () => {
    const isOrchestratorConfig = (cfg: unknown): boolean => {
      const r = AgentConfig.safeParse(cfg);
      return (
        r.success &&
        r.data.agentId === 'orchestrator' &&
        r.data.promptVersion === 'v1' &&
        JSON.stringify(r.data.allowlist) === JSON.stringify(['route']) &&
        r.data.model === 'claude-haiku-5-5'
      );
    };
    expect(isOrchestratorConfig(ORCHESTRATOR_CONFIG)).toBe(true);
    expect(
      isOrchestratorConfig({ ...ORCHESTRATOR_CONFIG, allowlist: ['route', 'get_my_balance'] }),
    ).toBe(false);
  });
});
