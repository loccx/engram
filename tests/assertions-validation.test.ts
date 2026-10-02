import { describe, expect, it } from 'vitest'
import {
  ASSERTION_MAX_DEPTH,
  ASSERTION_MAX_ITEMS,
  ASSERTION_MAX_PROPERTIES,
  ASSERTION_SCHEMA_MAX_BYTES,
  ASSERTION_VALUE_MAX_BYTES,
  canonicalJson,
  exactText,
  validateSchema,
  validateValue,
} from '../src/memory/assertions/validation.js'
import type { AssertionValueSchema } from '../src/memory/assertions/index.js'

// pure validation tests: no database, providers, filesystem state or credentials.
describe('strict bounded assertion validation', () => {
  it('validates all supported primitive, array and closed-object types without coercion', () => {
    const schema: AssertionValueSchema = {
      type: 'object', additionalProperties: false, required: ['name', 'count', 'enabled', 'nothing', 'items'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 4, enum: ['demo', '😀'] },
        count: { type: 'integer', minimum: 0, maximum: 3 },
        enabled: { type: 'boolean', enum: [true] },
        nothing: { type: 'null' },
        items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'number', minimum: -1, maximum: 2.5 } },
      },
    }
    const valid = { name: 'demo', count: 2, enabled: true, nothing: null, items: [1, 2.5] }
    expect(validateValue(valid, validateSchema(schema).schema).value).toEqual(valid)
    for (const change of [
      { name: 'else' }, { name: '' }, { name: 'toolong' }, { count: '2' }, { count: 2.1 }, { count: 4 },
      { enabled: false }, { enabled: 1 }, { nothing: 'null' }, { items: [] }, { items: [3] },
      { items: [1, 2, 2] }, { extra: true },
    ]) expect(() => validateValue({ ...valid, ...change }, schema)).toThrow(/assertion validation/)
    const { count: _omitted, ...missing } = valid
    expect(() => validateValue(missing, schema)).toThrow(/required/)
    expect(() => validateValue([], schema)).toThrow(/expected object/)
    expect(validateValue('😀', { type: 'string', minLength: 1, maxLength: 1 }).value).toBe('😀')
    expect(() => validateValue(Number.MAX_SAFE_INTEGER + 1, { type: 'integer' })).toThrow(/integer/)
  })

  it('rejects remote refs, executable or unknown keywords, schema flags and open objects', () => {
    for (const bad of [
      { $ref: 'https://invalid.test/schema.json' },
      { type: 'string', $ref: '#/other' },
      { type: 'string', format: 'email' },
      { type: 'string', pattern: '(a+)+' },
      { type: 'string', default: 'invented' },
      { type: 'string', verified_user: true },
      { type: ['string', 'null'] },
      { anyOf: [{ type: 'string' }] },
      { type: 'object', properties: {} },
      { type: 'object', properties: {}, additionalProperties: true },
      { type: 'array' },
      { type: 'string', minLength: 3, maxLength: 2 },
      { type: 'string', maxLength: 1.5 },
      { type: 'array', items: { type: 'null' }, maxItems: ASSERTION_MAX_ITEMS + 1 },
      { type: 'number', minimum: 2, maximum: 1 },
      { type: 'number', minimum: Infinity },
      { type: 'boolean', enum: [1] },
      { type: 'string', enum: [] },
      { type: 'string', enum: ['a', 'a'] },
      { type: 'object', properties: {}, additionalProperties: false, required: ['missing'] },
      { type: 'object', properties: { a: { type: 'null' } }, additionalProperties: false, required: ['a', 'a'] },
    ]) expect(() => validateSchema(bad)).toThrow(/assertion validation/)
  })

  it('enforces byte bounds at schema/value validation and query-value canonicalization', () => {
    const edge = 'x'.repeat(ASSERTION_VALUE_MAX_BYTES - 2)
    expect(Buffer.byteLength(validateValue(edge, { type: 'string' }).json)).toBe(ASSERTION_VALUE_MAX_BYTES)
    expect(() => validateValue(`${edge}x`, { type: 'string' })).toThrow(/byte bound/)
    expect(() => canonicalJson('é'.repeat(ASSERTION_VALUE_MAX_BYTES / 2))).toThrow(/byte bound/)
    expect(() => canonicalJson('\n'.repeat(ASSERTION_VALUE_MAX_BYTES / 2))).toThrow(/byte bound/)
    // escaped JSON, not raw string length, is the serialized payload ceiling.
    const enumSchema = { type: 'string', enum: Array.from({ length: 8 }, (_, index) => `${index}${'z'.repeat(2200)}`) }
    expect(() => validateSchema(enumSchema)).toThrow(/byte bound/)
    expect(ASSERTION_SCHEMA_MAX_BYTES).toBe(16384)
  })

  it('bounds nesting, nodes, items, property count and key bytes before serialization', () => {
    let nested: unknown = null
    for (let index = 0; index <= ASSERTION_MAX_DEPTH; index++) nested = [nested]
    expect(() => canonicalJson(nested)).toThrow(/depth/)
    expect(() => canonicalJson(Array(ASSERTION_MAX_ITEMS + 1).fill(null))).toThrow(/item bound/)
    expect(() => canonicalJson(Object.fromEntries(Array.from({ length: ASSERTION_MAX_PROPERTIES + 1 }, (_, index) => [`k${index}`, null])))).toThrow(/property bound/)
    expect(() => canonicalJson({ ['k'.repeat(257)]: null })).toThrow(/key exceeds/)
    expect(() => canonicalJson(Array.from({ length: 8 }, () => Array(128).fill(null)))).toThrow(/too many nodes/)
  })

  it('rejects non-JSON values, accessors and cycles without invoking them', () => {
    let calls = 0
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => { calls++; return 1 } })
    const toJson = { toJSON: () => { calls++; return 'invented' } }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const bad of [undefined, NaN, Infinity, -Infinity, 1n, () => null, new Date(0), new Map(), getter, toJson, cyclic, [undefined], Array(1)]) {
      expect(() => canonicalJson(bad)).toThrow(/assertion validation/)
    }
    const arrayGetter = Object.defineProperty([0], '0', { enumerable: true, get: () => { calls++; return 1 } })
    expect(() => canonicalJson(arrayGetter)).toThrow(/data arrays/)
    expect(() => canonicalJson({ [Symbol('x')]: 1 })).toThrow(/keys must be strings/)
    expect(() => canonicalJson(Object.defineProperty({}, 'hidden', { value: 1 }))).toThrow(/data fields/)
    expect(calls).toBe(0)
  })

  it('keeps identifiers exact without SQLite UTF-8 replacement or normalization', () => {
    expect(() => exactText('person:😀', 'subject')).not.toThrow()
    expect(() => exactText(' person:fixture ', 'subject')).not.toThrow()
    for (const bad of ['', 'x\u0000y', 'x\n', '\uD800', '\uDC00', 'x'.repeat(513)]) {
      expect(() => exactText(bad, 'subject')).toThrow(/assertion validation/)
    }
  })

  it('handles reserved property names as JSON data, never prototype mutation', () => {
    const json = '{"__proto__":{"x":1},"constructor":2}'
    const value: unknown = JSON.parse(json)
    expect(canonicalJson(value)).toBe(json)
    expect({}).not.toHaveProperty('x')
    const schema = validateSchema(JSON.parse(
      '{"type":"object","additionalProperties":false,"properties":{"__proto__":{"type":"null"}},"required":["__proto__"]}'
    )).schema
    expect(validateValue(JSON.parse('{"__proto__":null}'), schema).json).toBe('{"__proto__":null}')
    expect(() => validateValue({ constructor: null }, schema)).toThrow(/required|unknown/)
  })
})
