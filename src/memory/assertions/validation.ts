import type { AssertionJsonValue, AssertionValueSchema } from './types.js'

export const ASSERTION_VALUE_MAX_BYTES = 8192
export const ASSERTION_SCHEMA_MAX_BYTES = 16384
export const ASSERTION_MAX_DEPTH = 12
export const ASSERTION_MAX_NODES = 1024
export const ASSERTION_MAX_ITEMS = 256
export const ASSERTION_MAX_PROPERTIES = 128
export const ASSERTION_KEY_MAX_BYTES = 256
export const ASSERTION_QUERY_MAX = 100
export const ASSERTION_EVIDENCE_MAX = 20

function fail(message: string): never {
  throw new Error(`assertion validation: ${message}`)
}

/** no normalization: identifiers are byte-exact, case-sensitive data, not lexical terms. */
export function exactText(value: unknown, field: string, maxBytes = 512): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    fail(`${field} must be nonempty text of at most ${maxBytes} bytes`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(`${field} must not contain control characters`)
  // sqlite binds UTF-8: reject lone UTF-16 surrogates rather than silently replacing
  // them, which would make two different input identifiers compare as the same text.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    fail(`${field} must be well-formed Unicode text`)
  }
}

export function schemaId(value: unknown): asserts value is string {
  exactText(value, 'schema_id', 192)
  if (!/^[A-Za-z][A-Za-z0-9._:/-]{0,159}@[1-9][0-9]{0,8}(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/.test(value)) {
    fail('schema_id must be a name@version (positive major, optional minor and patch)')
  }
}

export function timestamp(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${field} must be a nonnegative safe-integer timestamp`)
  }
}

export function inputKeys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!isObject(value)) fail('input must be a plain object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail('unknown input field')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor) || !descriptor.enumerable) fail('input must contain only JSON data fields')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * canonical JSON equality is whole-value and type-sensitive, with sorted object keys.
 * inspect descriptors rather than invoking toJSON/getters. Bounds apply before recursion
 * or serialization, so cycles, huge containers and unsupported JS values fail closed.
 */
export function canonicalJson(value: unknown, maxBytes = ASSERTION_VALUE_MAX_BYTES): string {
  let nodes = 0
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > ASSERTION_MAX_NODES) fail('JSON has too many nodes')
    if (depth > ASSERTION_MAX_DEPTH) fail('JSON exceeds maximum depth')
    let json: string
    if (item === null || typeof item === 'boolean') {
      json = JSON.stringify(item)
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('JSON numbers must be finite')
      json = JSON.stringify(item)
    } else if (typeof item === 'string') {
      if (Buffer.byteLength(item) > maxBytes) fail('JSON exceeds byte bound')
      json = JSON.stringify(item)
    } else if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > ASSERTION_MAX_ITEMS) {
        fail('JSON array exceeds item bound or has a nonstandard prototype')
      }
      if (ancestors.has(item)) fail('JSON must not contain cycles')
      if (Reflect.ownKeys(item).length !== item.length + 1) fail('JSON arrays must be dense data arrays')
      ancestors.add(item)
      const values: string[] = []
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, `${index}`)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('JSON arrays must be dense data arrays')
        values.push(visit(descriptor.value, depth + 1))
      }
      ancestors.delete(item)
      json = `[${values.join(',')}]`
    } else if (isObject(item)) {
      if (ancestors.has(item)) fail('JSON must not contain cycles')
      const keys = Reflect.ownKeys(item)
      if (keys.length > ASSERTION_MAX_PROPERTIES) fail('JSON object exceeds property bound')
      if (keys.some((key) => typeof key !== 'string')) fail('JSON object keys must be strings')
      ancestors.add(item)
      const entries = (keys as string[]).sort().map((key) => {
        if (Buffer.byteLength(key) > ASSERTION_KEY_MAX_BYTES) fail('JSON object key exceeds byte bound')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!('value' in descriptor) || !descriptor.enumerable) fail('JSON objects must contain only data fields')
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
      })
      ancestors.delete(item)
      json = `{${entries.join(',')}}`
    } else {
      fail('value must be JSON data (no undefined, functions, bigint or class instances)')
    }
    if (Buffer.byteLength(json) > maxBytes) fail('JSON exceeds byte bound')
    return json
  }
  return visit(value, 0)
}

function schemaFields(schema: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(schema).some((key) => !allowed.includes(key))) {
    fail('unsupported schema keyword (only the local strict subset is accepted)')
  }
}

function boundedRange(schema: Record<string, unknown>, min: string, max: string, ceiling: number): void {
  for (const key of [min, max]) {
    if (schema[key] !== undefined &&
      (typeof schema[key] !== 'number' || !Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > ceiling)) {
      fail(`${key} must be a bounded nonnegative integer`)
    }
  }
  if (typeof schema[min] === 'number' && typeof schema[max] === 'number' && schema[min] > schema[max]) {
    fail(`${min} must not exceed ${max}`)
  }
}

/** validate the dialect itself before using it; never fetch a ref or compile user code. */
export function validateSchema(value: unknown): { schema: AssertionValueSchema; json: string } {
  const json = canonicalJson(value, ASSERTION_SCHEMA_MAX_BYTES)
  const schema: unknown = JSON.parse(json)
  const inspect = (item: unknown): void => {
    if (!isObject(item)) fail('schema node must be an object')
    switch (item.type) {
      case 'null':
        schemaFields(item, ['type'])
        break
      case 'boolean':
        schemaFields(item, ['type', 'enum'])
        break
      case 'string':
        schemaFields(item, ['type', 'minLength', 'maxLength', 'enum'])
        boundedRange(item, 'minLength', 'maxLength', ASSERTION_VALUE_MAX_BYTES)
        break
      case 'number':
      case 'integer':
        schemaFields(item, ['type', 'minimum', 'maximum', 'enum'])
        for (const key of ['minimum', 'maximum']) {
          if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]))) {
            fail(`${key} must be finite`)
          }
        }
        if (typeof item.minimum === 'number' && typeof item.maximum === 'number' && item.minimum > item.maximum) {
          fail('minimum must not exceed maximum')
        }
        break
      case 'array':
        schemaFields(item, ['type', 'items', 'minItems', 'maxItems'])
        boundedRange(item, 'minItems', 'maxItems', ASSERTION_MAX_ITEMS)
        inspect(item.items)
        break
      case 'object': {
        schemaFields(item, ['type', 'properties', 'required', 'additionalProperties'])
        if (item.additionalProperties !== false || !isObject(item.properties)) {
          fail('object schemas must declare properties and additionalProperties:false')
        }
        for (const child of Object.values(item.properties)) inspect(child)
        if (item.required !== undefined) {
          if (!Array.isArray(item.required) || item.required.some((key) => typeof key !== 'string' || !Object.hasOwn(item.properties as object, key))) {
            fail('required must name declared properties')
          }
          if (new Set(item.required).size !== item.required.length) fail('required must be unique')
        }
        break
      }
      default:
        fail('unsupported schema type')
    }
    if (item.enum !== undefined) {
      if (!Array.isArray(item.enum) || item.enum.length === 0 || item.enum.length > 64) fail('enum must contain 1..64 values')
      const withoutEnum = { ...item }
      delete withoutEnum.enum
      for (const entry of item.enum) validateValue(entry, withoutEnum as AssertionValueSchema)
      if (new Set(item.enum.map((entry) => canonicalJson(entry))).size !== item.enum.length) fail('enum must be unique')
    }
  }
  inspect(schema)
  return { schema: schema as AssertionValueSchema, json }
}

/** pure validation: no stripping unknown keys, defaults, coercion or semantic truth claims. */
export function validateValue(value: unknown, schema: AssertionValueSchema): { value: AssertionJsonValue; json: string } {
  const json = canonicalJson(value)
  const parsed = JSON.parse(json) as AssertionJsonValue
  const check = (item: AssertionJsonValue, rule: AssertionValueSchema): void => {
    switch (rule.type) {
      case 'null':
        if (item !== null) fail('expected null')
        break
      case 'boolean':
        if (typeof item !== 'boolean') fail('expected boolean')
        break
      case 'string': {
        if (typeof item !== 'string') fail('expected string')
        const length = Array.from(item).length
        if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? ASSERTION_VALUE_MAX_BYTES)) fail('string length outside schema bounds')
        break
      }
      case 'number':
      case 'integer':
        if (typeof item !== 'number' || (rule.type === 'integer' && !Number.isSafeInteger(item))) fail(`expected ${rule.type}`)
        if (item < (rule.minimum ?? -Infinity) || item > (rule.maximum ?? Infinity)) fail('number outside schema bounds')
        break
      case 'array':
        if (!Array.isArray(item)) fail('expected array')
        if (item.length < (rule.minItems ?? 0) || item.length > (rule.maxItems ?? ASSERTION_MAX_ITEMS)) fail('array length outside schema bounds')
        for (const child of item) check(child, rule.items)
        break
      case 'object':
        if (!isObject(item)) fail('expected object')
        if ((rule.required ?? []).some((key) => !Object.hasOwn(item, key))) fail('missing required property')
        for (const [key, child] of Object.entries(item)) {
          if (!Object.hasOwn(rule.properties, key)) fail('unknown value property')
          check(child, rule.properties[key])
        }
        break
    }
    if ('enum' in rule && rule.enum && !rule.enum.some((entry) => canonicalJson(entry) === canonicalJson(item))) {
      fail('value not in enum')
    }
  }
  check(parsed, schema)
  return { value: parsed, json }
}
