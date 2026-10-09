import { encodeObjectByAlias } from "./codec/common"
import { resolveStructFields } from "./fields"
import { isStruct } from "./guards"
import { parseStructValue } from "./introspection"
import { DEFINITION } from "./symbols"
import type {
  AnyStructLike,
  ArrayDefinition,
  EnumDefinition,
  LiteralDefinition,
  LiteralValue,
  ObjectDefinition,
  PrimitiveDefinition,
  PrimitiveKind,
  RuntimeStruct,
  StructDefinition
} from "./types"
import { hasOwnKey, isPlainObject, matchesEnum } from "./utils"
import { portableValueGraphError, PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "./value-graph"

/** Happy-path JSON encoder. Unsupported schemas compile to null. */
export type JsonEncoder = (value: unknown) => unknown

interface EncodeGraph {
  active: WeakSet<object>
  depth: number
  trusted: boolean
}

type JsonStep = (value: unknown, graph: EncodeGraph) => unknown

interface CoverCursor {
  seen: WeakSet<object>
  steps: Array<CoverStep | undefined>
  top: number
  values: unknown[]
}

type CoverStep = (value: unknown, cursor: CoverCursor) => boolean

const INVALID: unique symbol = Symbol("struct.json.encode.invalid")
const covers = new WeakMap<RuntimeStruct, CoverStep>()
const roots = new WeakMap<RuntimeStruct, JsonEncoder | null>()
const steps = new WeakMap<RuntimeStruct, JsonStep | null>()

function interpret(struct: AnyStructLike, value: unknown): unknown {
  return encodeObjectByAlias(struct, parseStructValue(struct, value), "json", true)
}

/** Encodes with the compiled fast path. Unsupported schemas use the interpreter. */
export function encodeCompiledJson(struct: AnyStructLike, value: unknown): unknown {
  const encoder = compileJsonEncoder(struct)
  if (encoder === null) return interpret(struct, value)
  const encoded = encoder(value)
  if (encoded !== INVALID) return encoded
  return interpret(struct, value)
}

/** Compiles a JSON encode fast path, or returns null when the schema must stay on the interpreter. */
export function compileJsonEncoder(struct: AnyStructLike): JsonEncoder | null {
  if (!isStruct(struct)) return null
  const runtime = struct as RuntimeStruct
  const cached = roots.get(runtime)
  if (cached !== undefined) return cached
  const step = compileStep(runtime)
  const encoder = step === null ? null : bindRoot(step, covers.get(runtime) as CoverStep)
  roots.set(runtime, encoder)
  return encoder
}

function bindRoot(step: JsonStep, cover: CoverStep): JsonEncoder {
  return (value) => {
    // Schema traversal already accounts for cycles and depth on containers it enters.
    // Keep the root walk when that traversal would miss part of the graph.
    if (runCover(value, cover)) return step(value, enterRoot(value, true))
    if (portableValueGraphError(value) !== undefined) return INVALID
    return step(value, enterRoot(value, false))
  }
}

function enterRoot(value: unknown, trusted: boolean): EncodeGraph {
  const graph: EncodeGraph = { active: new WeakSet(), depth: 0, trusted }
  const container = valueContainer(value)
  if (container !== undefined) {
    graph.depth = 1
    graph.active.add(container)
  }
  return graph
}

function valueContainer(value: unknown): object | undefined {
  if (Array.isArray(value) || isPlainObject(value)) return value
  return undefined
}

function runCover(value: unknown, step: CoverStep): boolean {
  const cursor: CoverCursor = {
    seen: new WeakSet(),
    steps: [step],
    top: 1,
    values: [value]
  }
  const root = valueContainer(value)
  if (root !== undefined) cursor.seen.add(root)
  while (cursor.top > 0) {
    cursor.top -= 1
    const current = cursor.values[cursor.top]
    const check = cursor.steps[cursor.top] as CoverStep
    cursor.values[cursor.top] = undefined
    cursor.steps[cursor.top] = undefined
    if (!check(current, cursor)) return false
  }
  return true
}

function enqueue(cursor: CoverCursor, value: unknown, step: CoverStep): boolean {
  const container = valueContainer(value)
  if (container !== undefined) {
    if (cursor.seen.has(container)) return false
    cursor.seen.add(container)
  }
  cursor.values[cursor.top] = value
  cursor.steps[cursor.top] = step
  cursor.top += 1
  return true
}

const leafCover: CoverStep = (value) => valueContainer(value) === undefined

function objectCover(fields: ReadonlyArray<{ cover: CoverStep; key: string }>): CoverStep {
  const allowed = new Set<string>()
  for (const field of fields) allowed.add(field.key)
  return (value, cursor) => {
    if (!isPlainObject(value)) return !Array.isArray(value)
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (!allowed.has(key)) return false
    }
    for (const field of fields) {
      if (!Object.hasOwn(value, field.key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, field.key)
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false
      if (!enqueue(cursor, descriptor.value, field.cover)) return false
    }
    return true
  }
}

function arrayCover(item: CoverStep): CoverStep {
  return (value, cursor) => {
    if (!Array.isArray(value)) return !isPlainObject(value)
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (!isArrayIndex(key, value.length)) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false
      if (!enqueue(cursor, descriptor.value, item)) return false
    }
    return true
  }
}

function isArrayIndex(key: string, length: number): boolean {
  const size = key.length
  if (size === 0 || size > 10) return false
  if (size > 1 && key.charCodeAt(0) === 48) return false
  let index = 0
  for (let cursor = 0; cursor < size; cursor += 1) {
    const code = key.charCodeAt(cursor)
    if (code < 48 || code > 57) return false
    index = index * 10 + (code - 48)
  }
  return index < length
}

function nested(step: JsonStep): JsonStep {
  return (value, graph) => {
    const container = valueContainer(value)
    if (container === undefined) return step(value, graph)
    const depth = graph.depth + 1
    if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) return INVALID
    if (graph.active.has(container)) return INVALID
    graph.depth = depth
    graph.active.add(container)
    try {
      return step(value, graph)
    } finally {
      graph.active.delete(container)
      graph.depth -= 1
    }
  }
}

function compileStep(struct: RuntimeStruct): JsonStep | null {
  const cached = steps.get(struct)
  if (cached !== undefined) return cached
  const step = compileDefinition(struct)
  steps.set(struct, step)
  return step
}

function remember(struct: RuntimeStruct, step: JsonStep, cover: CoverStep): JsonStep {
  covers.set(struct, cover)
  return step
}

function compileDefinition(struct: RuntimeStruct): JsonStep | null {
  const definition = struct[DEFINITION]
  if (definition.alias !== undefined) return null

  switch (definition.kind) {
    case "any":
    case "unknown":
      return remember(
        struct,
        compileChecked(definition, (value) =>
          portableValueGraphError(value) !== undefined ? INVALID : value
        ),
        leafCover
      )
    case "array":
      return compileArray(struct, definition)
    case "enum":
      return remember(struct, compileEnum(definition), leafCover)
    case "literal":
      return remember(struct, compileLiteral(definition), leafCover)
    case "object":
      return compileObject(struct, definition)
    case "arrayBuffer":
    case "bigint":
    case "blob":
    case "boolean":
    case "date":
    case "file":
    case "null":
    case "number":
    case "string":
      return compilePrimitive(struct, definition)
    case "discriminatedUnion":
    case "intersection":
    case "or":
    case "record":
    case "tuple":
      return null
  }
}

function compileArray(struct: RuntimeStruct, definition: ArrayDefinition): JsonStep | null {
  const itemStruct = definition.item as RuntimeStruct
  const item = compileStep(itemStruct)
  if (item === null) return null
  const element = nested(item)
  return remember(
    struct,
    compileChecked(definition, (value, graph) => {
      if (!Array.isArray(value)) return INVALID
      const output: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const raw = readIndex(value, index, graph.trusted)
        if (raw === INVALID) return INVALID
        const encoded = element(raw, graph)
        if (encoded === INVALID) return INVALID
        output.push(encoded)
      }
      return output
    }),
    arrayCover(covers.get(itemStruct) as CoverStep)
  )
}

function compileEnum(definition: EnumDefinition<string | number>): JsonStep {
  return compileChecked(definition, (value) => (matchesEnum(definition, value) ? value : INVALID))
}

function compileLiteral(definition: LiteralDefinition<LiteralValue>): JsonStep {
  const expected = definition.value
  return compileChecked(definition, (value) => (Object.is(value, expected) ? value : INVALID))
}

function compileObject(struct: RuntimeStruct, definition: ObjectDefinition): JsonStep | null {
  const descriptors = definition.cache.declaredDescriptors
  for (const key of Object.keys(descriptors)) {
    if (typeof descriptors[key]?.get === "function") return null
  }

  const compiledFields: Array<{ key: string; step: JsonStep }> = []
  const covered: Array<{ cover: CoverStep; key: string }> = []
  for (const field of resolveStructFields(struct, definition)) {
    const step = compileStep(field.struct)
    if (step === null) return null
    compiledFields.push({ key: field.key, step: nested(step) })
    covered.push({ cover: covers.get(field.struct) as CoverStep, key: field.key })
  }

  return remember(
    struct,
    compileChecked(definition, (value, graph) => {
      if (!isPlainObject(value)) return INVALID
      const output: { [key: string]: unknown } = Object.create(null)
      for (const field of compiledFields) {
        const raw = readOwn(value, field.key, graph.trusted)
        if (raw === INVALID) return INVALID
        const encoded = field.step(raw, graph)
        if (encoded === INVALID) return INVALID
        if (encoded !== undefined) output[field.key] = encoded
      }
      return output
    }),
    objectCover(covered)
  )
}

function compilePrimitive(
  struct: RuntimeStruct,
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>
): JsonStep | null {
  if (definition.decode !== undefined || definition.encode !== undefined) return null
  const check = definition.is
  return remember(
    struct,
    compileChecked(definition, (value) => (check(value) ? value : INVALID)),
    leafCover
  )
}

function compileChecked(definition: StructDefinition, accept: JsonStep): JsonStep {
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  return (value, graph) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) return nullOk ? null : INVALID
    return accept(value, graph)
  }
}

function readOwn(value: { [key: string]: unknown }, key: string, trusted: boolean): unknown {
  if (!hasOwnKey(value, key)) return undefined
  if (!trusted) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return INVALID
  }
  return value[key]
}

function readIndex(value: unknown[], index: number, trusted: boolean): unknown {
  if (!Object.hasOwn(value, index)) return undefined
  if (!trusted) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return INVALID
  }
  return value[index]
}

function acceptsNull(definition: StructDefinition): boolean {
  if (definition.flags.nullable || definition.kind === "null") return true
  return definition.kind === "literal" && definition.value === null
}
