import { encodeObjectByAlias } from "./codec/common"
import { StructError } from "./errors"
import { resolveStructFields } from "./fields"
import { isStruct } from "./guards"
import { parseStructValue } from "./introspection"
import { parseEncodeQuiet } from "./parse"
import { DEFINITION } from "./symbols"
import type {
  AnyStructLike,
  ArrayDefinition,
  EnumDefinition,
  LiteralDefinition,
  LiteralValue,
  ObjectDefinition,
  Path,
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

type JsonStep = ((value: unknown, graph: EncodeGraph, path?: Path) => unknown) & {
  needsPath?: true
}

interface CoverCursor {
  seen: WeakSet<object>
  steps: Array<CoverStep | undefined>
  top: number
  values: unknown[]
}

type CoverStep = (value: unknown, cursor: CoverCursor) => boolean

const INVALID: unique symbol = Symbol("struct.json.encode.invalid")
const SKIP_ENCODE: unique symbol = Symbol("struct.json.encode.skip")
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
  // An island parses its subtree and then encodes that subtree. The interpreter
  // parses the whole value before encoding it, so hook order can differ. A hook
  // that already succeeded runs again when INVALID falls back to the interpreter.
  // StructError and TypeError results still come only from that rerun.
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
  const encoder = step === null ? null : bindRoot(runtime, step, covers.get(runtime) as CoverStep)
  roots.set(runtime, encoder)
  return encoder
}

function publishSkipped(struct: RuntimeStruct, encoded: unknown): unknown {
  if (encoded !== SKIP_ENCODE) return encoded
  try {
    return encodeObjectByAlias(struct, undefined, "json", true)
  } catch (error) {
    if (error instanceof StructError || error instanceof TypeError) return INVALID
    throw error
  }
}

function bindRoot(struct: RuntimeStruct, step: JsonStep, cover: CoverStep): JsonEncoder {
  if (step.needsPath === true) {
    return (value) => {
      if (runCover(value, cover))
        return publishSkipped(struct, step(value, enterRoot(value, true), []))
      if (portableValueGraphError(value) !== undefined) return INVALID
      return publishSkipped(struct, step(value, enterRoot(value, false), []))
    }
  }
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
  if (step.needsPath === true) {
    const run: JsonStep = (value, graph, path) => {
      const container = valueContainer(value)
      if (container === undefined) return step(value, graph, path)
      const depth = graph.depth + 1
      if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) return INVALID
      if (graph.active.has(container)) return INVALID
      graph.depth = depth
      graph.active.add(container)
      try {
        return step(value, graph, path)
      } finally {
        graph.active.delete(container)
        graph.depth -= 1
      }
    }
    run.needsPath = true
    return run
  }
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
  // alias selects the parent object's output key. It does not change this node's encoding.
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
      return compileIsland(struct, [...definition.map.values()] as RuntimeStruct[])
    case "intersection":
    case "or":
      return compileIsland(struct, definition.options as unknown as readonly RuntimeStruct[])
    case "record":
      return compileIsland(struct, [definition.value as RuntimeStruct])
    case "tuple":
      return compileIsland(struct, definition.items as unknown as readonly RuntimeStruct[])
  }
}

function compileIsland(struct: RuntimeStruct, children: readonly RuntimeStruct[]): JsonStep | null {
  for (const child of children) {
    if (compileStep(child) === null) return null
  }
  // The fast path does not walk an island. A container must fail this cover so
  // bindRoot keeps the root graph scan; a non-container counts as covered.
  return remember(struct, islandStep(struct), leafCover)
}

function islandStep(struct: RuntimeStruct): JsonStep {
  const definition = struct[DEFINITION]
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  const passNull = definition.kind === "or" || definition.kind === "intersection"
  const run: JsonStep = (value, _graph, path = []) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) {
      if (nullOk) return null
      if (!passNull) return INVALID
    }
    let parsed: ReturnType<typeof parseEncodeQuiet>
    try {
      parsed = parseEncodeQuiet(struct, value, path)
    } catch (error) {
      if (error instanceof StructError) return INVALID
      throw error
    }
    if (!parsed.ok) return INVALID
    if (parsed.value === undefined) return SKIP_ENCODE
    try {
      return encodeObjectByAlias(struct, parsed.value, "json", true)
    } catch (error) {
      if (error instanceof StructError || error instanceof TypeError) return INVALID
      throw error
    }
  }
  run.needsPath = true
  return run
}

function compileArray(struct: RuntimeStruct, definition: ArrayDefinition): JsonStep | null {
  const itemStruct = definition.item as RuntimeStruct
  const item = compileStep(itemStruct)
  if (item === null) return null
  const element = nested(item)
  const cover = arrayCover(covers.get(itemStruct) as CoverStep)
  if (element.needsPath === true) {
    const accept: JsonStep = (value, graph, path = []) => {
      if (!Array.isArray(value)) return INVALID
      const output: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const raw = readIndex(value, index, graph.trusted)
        if (raw === INVALID) return INVALID
        path.push(index)
        let encoded: unknown
        try {
          encoded = element(raw, graph, path)
        } finally {
          path.pop()
        }
        if (encoded === INVALID) return INVALID
        if (encoded === SKIP_ENCODE) {
          try {
            encoded = encodeObjectByAlias(itemStruct, undefined, "json", true)
          } catch (error) {
            if (error instanceof StructError || error instanceof TypeError) return INVALID
            throw error
          }
        }
        output.push(encoded)
      }
      return output
    }
    accept.needsPath = true
    return remember(struct, compileChecked(definition, accept), cover)
  }
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
    cover
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

  const compiledFields: Array<{
    key: string
    optional: boolean
    step: JsonStep
    wireKey: string
  }> = []
  const covered: Array<{ cover: CoverStep; key: string }> = []
  let needsPath = false
  for (const field of resolveStructFields(struct, definition)) {
    const step = compileStep(field.struct)
    if (step === null) return null
    const nestedStep = nested(step)
    if (nestedStep.needsPath === true) needsPath = true
    compiledFields.push({
      key: field.key,
      optional: field.struct[DEFINITION].flags.optional,
      step: nestedStep,
      wireKey: field.wireKey
    })
    covered.push({ cover: covers.get(field.struct) as CoverStep, key: field.key })
  }

  const cover = objectCover(covered)
  if (needsPath) {
    const accept: JsonStep = (value, graph, path = []) => {
      if (!isPlainObject(value)) return INVALID
      const output: { [key: string]: unknown } = Object.create(null)
      for (const field of compiledFields) {
        const raw = readOwn(value, field.key, graph.trusted)
        if (raw === INVALID) return INVALID
        if (raw === undefined) {
          if (!field.optional) return INVALID
          continue
        }
        let encoded: unknown
        if (field.step.needsPath === true) {
          path.push(field.key)
          try {
            encoded = field.step(raw, graph, path)
          } finally {
            path.pop()
          }
        } else encoded = field.step(raw, graph)
        if (encoded === INVALID) return INVALID
        if (encoded === SKIP_ENCODE) continue
        output[field.wireKey] = encoded
      }
      return output
    }
    accept.needsPath = true
    return remember(struct, compileChecked(definition, accept), cover)
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
        if (encoded !== undefined) output[field.wireKey] = encoded
      }
      return output
    }),
    cover
  )
}

function compilePrimitive(
  struct: RuntimeStruct,
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>
): JsonStep | null {
  if (definition.decode !== undefined || definition.encode !== undefined) {
    return remember(struct, islandStep(struct), leafCover)
  }
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
  if (accept.needsPath === true) {
    const run: JsonStep = (value, graph, path) => {
      if (value === undefined) return optional ? undefined : INVALID
      if (value === null) return nullOk ? null : INVALID
      return accept(value, graph, path)
    }
    run.needsPath = true
    return run
  }
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
