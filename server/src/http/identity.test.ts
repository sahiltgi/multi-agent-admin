// AT-3 (specs/approval-queue.md, rule 2): ADR-0005 exists and the production guard refuses.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertDemoIdentityAllowed,
  DemoIdentityRefusedError,
  parseDemoUserHeader,
} from './identity.js';

const ADR = new URL('../../../docs/adr/0005-demo-user-header.md', import.meta.url);

describe('demo identity guard', () => {
  it('AT-1: parseDemoUserHeader matches exactly, with no trimming', () => {
    const bad: (string | string[] | undefined)[] = [
      undefined,
      '',
      '   ',
      ' emp-002',
      'emp-002 ',
      'emp-002\nx: y',
      'emp-002, emp-001',
      ['emp-002', 'emp-001'],
    ];
    for (const raw of bad) {
      expect(parseDemoUserHeader(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(parseDemoUserHeader('emp-002')).toBe('emp-002');
    expect(parseDemoUserHeader('EMP-002')).toBe('EMP-002');
  });

  it('AT-3: docs/adr/0005-demo-user-header.md documents the shortcut and the production refusal', () => {
    expect(existsSync(ADR)).toBe(true);
    const text = readFileSync(ADR, 'utf8');
    expect(text).toContain('x-demo-user');
    expect(text).toContain('NODE_ENV=production');
    expect(text).toMatch(/Status:/);
  });

  it('AT-3: assertDemoIdentityAllowed throws DemoIdentityRefusedError in production', () => {
    expect(() => {
      assertDemoIdentityAllowed('production');
    }).toThrow(DemoIdentityRefusedError);
  });

  it('AT-3: assertDemoIdentityAllowed returns for development, test and undefined', () => {
    expect(() => {
      assertDemoIdentityAllowed('development');
    }).not.toThrow();
    expect(() => {
      assertDemoIdentityAllowed('test');
    }).not.toThrow();
    expect(() => {
      assertDemoIdentityAllowed(undefined);
    }).not.toThrow();
  });
});
