import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, createProductionRegistry } from './registry.js';

function holidaysTool(): Parameters<ToolRegistry['register']>[0] {
  return {
    name: 'get_holidays',
    description: 'List public holidays for a year (synthetic fixture).',
    inputSchema: z.object({ year: z.number().int() }).strict(),
    outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
    handler: () => Promise.resolve({ holidays: ['2026-12-25'] }),
  };
}

describe('ToolRegistry', () => {
  it('AT-19: registering get_holidays twice throws on the second registration', () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register(holidaysTool());
    }).not.toThrow();
    expect(() => {
      registry.register(holidaysTool());
    }).toThrow();
    expect(registry.names().filter((n) => n === 'get_holidays')).toHaveLength(1);
  });

  it('AT-20: production registry has no approval, compensation or termination tool names', () => {
    const names = createProductionRegistry({ route: 'Synthetic route description.' }).names();
    const forbidden =
      /approve|compens|salary|payroll|bonus|terminat|dismiss|fire_|edit_employee|update_employee/i;
    for (const name of names) {
      expect(name).not.toMatch(forbidden);
    }
  });

  it('AT-30: the production registry route spec carries the given description', () => {
    const registry = createProductionRegistry({ route: 'Synthetic route description.' });
    expect(registry.specFor('route').description).toBe('Synthetic route description.');
  });

  it('registry: registering a tool whose inputSchema is not strict throws', () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register({
        name: 'get_holidays',
        description: 'Loose input (synthetic fixture).',
        inputSchema: z.object({ year: z.number().int() }),
        outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
        handler: () => Promise.resolve({ holidays: [] }),
      });
    }).toThrow();
    expect(registry.has('get_holidays')).toBe(false);
  });

  it('registry: specFor returns a strict tool spec with additionalProperties false and no $schema', () => {
    const registry = new ToolRegistry();
    registry.register(holidaysTool());
    expect(registry.has('get_holidays')).toBe(true);
    const spec = registry.specFor('get_holidays');
    expect(spec.name).toBe('get_holidays');
    expect(spec.description).toBe('List public holidays for a year (synthetic fixture).');
    expect(spec.strict).toBe(true);
    expect(spec.input_schema.additionalProperties).toBe(false);
    expect('$schema' in spec.input_schema).toBe(false);
    expect(Object.keys(spec).sort()).toEqual(['description', 'input_schema', 'name', 'strict']);
  });

  it('registry: a nested object that is not strict makes registration throw', () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register({
        name: 'get_holidays',
        description: 'Nested loose input (synthetic fixture).',
        inputSchema: z.object({ range: z.object({ year: z.number().int() }) }).strict(),
        outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
        handler: () => Promise.resolve({ holidays: [] }),
      });
    }).toThrow();
    expect(registry.has('get_holidays')).toBe(false);
  });

  it('registry: a nested object that is strict registers', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'get_holidays',
      description: 'Nested strict input (synthetic fixture).',
      inputSchema: z.object({ range: z.object({ year: z.number().int() }).strict() }).strict(),
      outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
      handler: () => Promise.resolve({ holidays: [] }),
    });
    expect(registry.has('get_holidays')).toBe(true);
  });

  it('registry: an untyped nested schema (z.unknown or z.any) makes registration throw', () => {
    for (const loose of [z.unknown(), z.any()]) {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          name: 'get_holidays',
          description: 'Untyped field (synthetic fixture).',
          inputSchema: z.object({ meta: loose }).strict(),
          outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
          handler: () => Promise.resolve({ holidays: [] }),
        });
      }).toThrow();
      expect(registry.has('get_holidays')).toBe(false);
    }
  });

  it('registry: nullable, optional, enum, literal and arrays of strict objects register', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'get_holidays',
      description: 'Typed fields (synthetic fixture).',
      inputSchema: z
        .object({
          a: z.string().nullable(),
          b: z.string().optional(),
          c: z.enum(['x', 'y']),
          d: z.literal('k'),
          e: z.array(z.object({ f: z.number() }).strict()),
        })
        .strict(),
      outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
      handler: () => Promise.resolve({ holidays: [] }),
    });
    expect(registry.has('get_holidays')).toBe(true);
  });

  it('registry: an input schema with an identity key at any depth makes registration throw (rule 15)', () => {
    const schemas = [
      z.object({ employeeId: z.string() }).strict(),
      z.object({ filter: z.object({ role: z.string() }).strict() }).strict(),
      z.object({ items: z.array(z.object({ managerId: z.string() }).strict()) }).strict(),
    ];
    for (const inputSchema of schemas) {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          name: 'get_holidays',
          description: 'Identity key in input (synthetic fixture).',
          inputSchema,
          outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
          handler: () => Promise.resolve({ holidays: [] }),
        });
      }).toThrow();
      expect(registry.has('get_holidays')).toBe(false);
    }
    expect(createProductionRegistry({ route: 'Synthetic route description.' }).has('route')).toBe(
      true,
    );
  });

  it('registry: identity keys are matched case- and separator-insensitively (rule 15)', () => {
    for (const key of [
      'employee_id',
      'employeeID',
      'EmployeeId',
      'userId',
      'requester_id',
      'Role',
      'employee',
      'user',
      'requester',
    ]) {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          name: 'get_holidays',
          description: 'Identity key variant (synthetic fixture).',
          inputSchema: z.object({ [key]: z.string() }).strict(),
          outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
          handler: () => Promise.resolve({ holidays: [] }),
        });
      }, key).toThrow();
    }
    const ok = new ToolRegistry();
    ok.register({
      name: 'get_holidays',
      description: 'Explicit target id (synthetic fixture).',
      inputSchema: z.object({ newHireId: z.string() }).strict(),
      outputSchema: z.object({ holidays: z.array(z.string()) }).strict(),
      handler: () => Promise.resolve({ holidays: [] }),
    });
    expect(ok.has('get_holidays')).toBe(true);
  });

  it('registry: an outputSchema that accepts undefined makes registration throw (D-2)', () => {
    for (const outputSchema of [z.void(), z.undefined(), z.string().optional()]) {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          name: 'get_holidays',
          description: 'Output may be undefined (synthetic fixture).',
          inputSchema: z.object({ year: z.number().int() }).strict(),
          outputSchema,
          handler: () => Promise.resolve(undefined),
        });
      }).toThrow();
      expect(registry.has('get_holidays')).toBe(false);
    }
  });
});
