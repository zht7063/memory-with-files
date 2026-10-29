import { MwfError } from '../core/index.ts';

/**
 * A deliberately small JSON-Schema subset (type, enum, properties, required, items, minimum,
 * maximum, minLength, maxLength, additionalProperties). Every CLI function declares its input with
 * it, so the same description validates input arriving from untyped callers (MCP tool arguments,
 * the command line) and can be handed to MCP as the tool's `inputSchema` unchanged.
 */
export type Schema =
  | { type: 'string'; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: Schema; maxItems?: number }
  | ObjectSchema;

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, Schema & { description?: string }>;
  required?: readonly string[];
  /** Always false: unknown keys are rejected, so a typo never silently does nothing. */
  additionalProperties?: false;
  description?: string;
}

function fail(path: string, message: string): never {
  throw new MwfError('INVALID_ARGUMENT', `${path || 'input'}: ${message}`, { path: path || '' });
}

function check(value: unknown, schema: Schema, path: string): void {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') fail(path, 'must be a string');
      if (schema.enum && !schema.enum.includes(value)) {
        fail(path, `must be one of ${schema.enum.join(', ')}`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        fail(path, `must not be shorter than ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        fail(path, `must not be longer than ${schema.maxLength} characters`);
      }
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer');
      if (schema.minimum !== undefined && value < schema.minimum) {
        fail(path, `must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        fail(path, `must be <= ${schema.maximum}`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail(path, 'must be a boolean');
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, 'must be an array');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        fail(path, `must not have more than ${schema.maxItems} items`);
      }
      value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`));
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(path, 'must be an object');
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema.properties, key)) {
          fail(path ? `${path}.${key}` : key, 'is not a recognised field');
        }
      }
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) fail(path ? `${path}.${key}` : key, 'is required');
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (record[key] !== undefined) check(record[key], sub, path ? `${path}.${key}` : key);
      }
    }
  }
}

/** Validate `input` against `schema`; throws INVALID_ARGUMENT naming the first offending field. */
export function validate(schema: ObjectSchema, input: unknown): Record<string, unknown> {
  check(input ?? {}, schema, '');
  return (input ?? {}) as Record<string, unknown>;
}
