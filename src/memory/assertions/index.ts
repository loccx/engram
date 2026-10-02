// the only writable surface is trusted local-owner host code. Parent integration may
// expose queryAssertions to agents, never schema registration or attachment tool args.
export {
  attachAssertion,
  queryAssertions,
  registerAssertionSchema,
  replaceAssertionRepresentation,
} from './store.js'
export {
  ASSERTION_EVIDENCE_MAX,
  ASSERTION_KEY_MAX_BYTES,
  ASSERTION_MAX_DEPTH,
  ASSERTION_MAX_ITEMS,
  ASSERTION_MAX_NODES,
  ASSERTION_MAX_PROPERTIES,
  ASSERTION_QUERY_MAX,
  ASSERTION_SCHEMA_MAX_BYTES,
  ASSERTION_VALUE_MAX_BYTES,
} from './validation.js'
export type {
  AssertionEvidenceRef,
  AssertionJsonValue,
  AssertionQueryResult,
  AssertionValueSchema,
  AttachAssertionInput,
  MemoryAssertion,
  QueryAssertionsInput,
  RegisteredAssertionSchema,
  RegisterAssertionSchemaInput,
  ReplaceAssertionRepresentationInput,
} from './types.js'
