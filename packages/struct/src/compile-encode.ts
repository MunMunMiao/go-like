// Values with side-effecting proxy traps or accessors are outside the contract.
// The fast path may observe them before the interpreter reruns.

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
  DiscriminatedUnionDefinition,
  EnumDefinition,
  LiteralDefinition,
  LiteralValue,
  ObjectDefinition,
  Path,
  PrimitiveDefinition,
  PrimitiveKind,
  RecordDefinition,
  RuntimeStruct,
  StructDefinition,
  TupleDefinition,
  UnionDefinition
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

function ownEnumerableKeys(value: object): string[] {
  const keys: string[] = []
  for (const key in value) {
    if (Object.hasOwn(value, key)) keys.push(key)
  }
  return keys
}

function recordCover(item: CoverStep): CoverStep {
  return (value, cursor) => {
    if (!isPlainObject(value)) return !Array.isArray(value)
    const keys = ownEnumerableKeys(value)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      )
        return false
      if (!enqueue(cursor, descriptor.value, item)) return false
    }
    return true
  }
}

function tupleCover(items: readonly CoverStep[]): CoverStep {
  const width = items.length
  return (value, cursor) => {
    if (!Array.isArray(value)) return !isPlainObject(value)
    if (value.length > width) return false
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (!isArrayIndex(key, value.length)) return false
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, index)
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false
      const item = items[index]
      if (item === undefined || !enqueue(cursor, descriptor.value, item)) return false
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
      return compileDiscriminatedUnion(struct, definition)
    case "intersection":
      return compileIsland(struct, definition.options as unknown as readonly RuntimeStruct[])
    case "or":
      return compileOr(struct, definition)
    case "record":
      return compileRecord(struct, definition)
    case "tuple":
      return compileTuple(struct, definition)
  }
}

function compileOr(struct: RuntimeStruct, definition: UnionDefinition): JsonStep | null {
  const optionStructs = definition.options as unknown as readonly RuntimeStruct[]
  const compiled: JsonStep[] = []
  for (const option of optionStructs) {
    const step = compileStep(option)
    if (step === null) return null
    compiled.push(step)
  }
  if (!unionOptionsProvablyDisjoint(optionStructs)) {
    return remember(struct, islandStep(struct), leafCover)
  }
  return remember(struct, disjointOrStep(definition, compiled), disjointUnionCover(optionStructs))
}

function disjointOrStep(definition: UnionDefinition, steps: readonly JsonStep[]): JsonStep {
  const optional = definition.flags.optional
  const nullable = definition.flags.nullable
  return (value, graph) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null && nullable) return null
    for (const step of steps) {
      const encoded = step(value, graph)
      if (encoded !== INVALID) return encoded
    }
    return INVALID
  }
}

function disjointUnionCover(options: readonly RuntimeStruct[]): CoverStep {
  let arrayStep: CoverStep | undefined
  const objects: RuntimeStruct[] = []
  for (const option of options) {
    const kind = option[DEFINITION].kind
    if (kind === "array") arrayStep = covers.get(option) as CoverStep
    else if (kind === "object") objects.push(option)
  }
  const objectStep = coverObjects(objects)
  return (value, cursor) => {
    if (Array.isArray(value)) {
      if (arrayStep === undefined) return false
      return arrayStep(value, cursor)
    }
    if (isPlainObject(value)) {
      if (objectStep === undefined) return false
      return objectStep(value, cursor)
    }
    return true
  }
}

function coverObjects(objects: readonly RuntimeStruct[]): CoverStep | undefined {
  const first = objects[0]
  if (first === undefined) return undefined
  if (objects.length === 1) return covers.get(first) as CoverStep
  const key = (tagOf(first, first[DEFINITION] as ObjectDefinition) as ObjectTag).key
  const arms: Array<{ cover: CoverStep; value: LiteralValue }> = []
  for (const option of objects) {
    const tag = tagOf(option, option[DEFINITION] as ObjectDefinition) as ObjectTag
    arms.push({ cover: covers.get(option) as CoverStep, value: tag.value })
  }
  return (value, cursor) => {
    if (!isPlainObject(value) || !Object.hasOwn(value, key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false
    for (const arm of arms) {
      if (Object.is(arm.value, descriptor.value)) return arm.cover(value, cursor)
    }
    return false
  }
}

function compileDiscriminatedUnion(
  struct: RuntimeStruct,
  definition: DiscriminatedUnionDefinition
): JsonStep | null {
  const steps = new Map<unknown, JsonStep>()
  const optionCovers = new Map<unknown, CoverStep>()
  let needsPath = false
  for (const [value, option] of definition.map) {
    const optionStruct = option as RuntimeStruct
    const step = compileStep(optionStruct)
    if (step === null) return null
    if (step.needsPath === true) needsPath = true
    steps.set(value, step)
    optionCovers.set(value, covers.get(optionStruct) as CoverStep)
  }
  return remember(
    struct,
    discriminatedUnionStep(definition, steps, needsPath),
    discriminatedUnionCover(definition.discriminator, optionCovers)
  )
}

function discriminatedUnionStep(
  definition: DiscriminatedUnionDefinition,
  steps: ReadonlyMap<unknown, JsonStep>,
  needsPath: boolean
): JsonStep {
  const key = definition.discriminator
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  const run: JsonStep = (value, graph, path) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) return nullOk ? null : INVALID
    if (!isPlainObject(value)) return INVALID
    const raw = readOwn(value, key, graph.trusted)
    if (raw === INVALID || raw === undefined) return INVALID
    const step = steps.get(raw)
    if (step === undefined) return INVALID
    if (step.needsPath === true) return step(value, graph, path)
    return step(value, graph)
  }
  if (needsPath) run.needsPath = true
  return run
}

function discriminatedUnionCover(
  key: string,
  optionCovers: ReadonlyMap<unknown, CoverStep>
): CoverStep {
  return (value, cursor) => {
    if (!isPlainObject(value)) return !Array.isArray(value)
    if (!Object.hasOwn(value, key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false
    if (descriptor.value === undefined) return false
    const cover = optionCovers.get(descriptor.value)
    if (cover === undefined) return false
    return cover(value, cursor)
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
  // One island call for the whole array. Per-element island calls rebuild a parse
  // graph and an encode graph, and a container element fails cover into a root scan.
  if (item.needsPath === true) return remember(struct, islandStep(struct), leafCover)
  const element = nested(item)
  const cover = arrayCover(covers.get(itemStruct) as CoverStep)
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

function compileRecord(struct: RuntimeStruct, definition: RecordDefinition): JsonStep | null {
  const valueStruct = definition.value as RuntimeStruct
  const step = compileStep(valueStruct)
  if (step === null) return null
  if (step.needsPath === true) return remember(struct, islandStep(struct), leafCover)
  return remember(
    struct,
    compileChecked(definition, recordAccept(nested(step))),
    recordCover(covers.get(valueStruct) as CoverStep)
  )
}

function recordAccept(valueStep: JsonStep): JsonStep {
  return (value, graph) => {
    if (!isPlainObject(value)) return INVALID
    const keys = ownEnumerableKeys(value)
    const output: { [key: string]: unknown } = Object.create(null)
    for (const key of keys) {
      const raw = readRecord(value, key, graph.trusted)
      if (raw === INVALID) return INVALID
      const encoded = valueStep(raw, graph)
      if (encoded === INVALID) return INVALID
      if (encoded === undefined) continue
      output[key] = encoded
    }
    return output
  }
}

function compileTuple(struct: RuntimeStruct, definition: TupleDefinition): JsonStep | null {
  const itemStructs = definition.items as unknown as readonly RuntimeStruct[]
  const compiled: JsonStep[] = []
  const itemCovers: CoverStep[] = []
  let island = false
  for (const item of itemStructs) {
    const step = compileStep(item)
    if (step === null) return null
    if (step.needsPath === true) island = true
    compiled.push(nested(step))
    itemCovers.push(covers.get(item) as CoverStep)
  }
  if (island) return remember(struct, islandStep(struct), leafCover)
  return remember(struct, compileChecked(definition, tupleAccept(compiled)), tupleCover(itemCovers))
}

function tupleAccept(items: readonly JsonStep[]): JsonStep {
  const width = items.length
  return (value, graph) => {
    if (!Array.isArray(value) || value.length !== width) return INVALID
    const output: unknown[] = []
    for (let index = 0; index < width; index += 1) {
      const raw = readIndex(value, index, graph.trusted)
      if (raw === INVALID) return INVALID
      const encoded = (items[index] as JsonStep)(raw, graph)
      if (encoded === INVALID) return INVALID
      output.push(encoded)
    }
    return output
  }
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
  // Field count is fixed. Hoisting an all-island object would change the per-field
  // hook order locked for { left, right }. An array of such objects is one island.
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

function readRecord(value: { [key: string]: unknown }, key: string, trusted: boolean): unknown {
  if (!trusted) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    )
      return INVALID
  }
  return value[key]
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

interface UnionAtom {
  looseZero: boolean
  value: boolean | number | string
}

interface ObjectTag {
  key: string
  value: LiteralValue
}

interface UnionDomain {
  arrays: boolean
  booleans: boolean
  finite: readonly UnionAtom[]
  nulls: boolean
  numbers: boolean
  object: ObjectTag | true | undefined
  strings: boolean
  undefs: boolean
}

/**
 * True when each option's accepted set is pairwise disjoint under matchesRuntimeValue,
 * and parse of a matching option cannot move the value into another option.
 * Options that are not in a closed identity fragment return false.
 */
export function unionOptionsProvablyDisjoint(options: readonly RuntimeStruct[]): boolean {
  const domains: UnionDomain[] = []
  for (const option of options) {
    const domain = domainOf(option)
    if (domain === undefined) return false
    domains.push(domain)
  }
  for (let left = 0; left < domains.length; left += 1) {
    for (let right = left + 1; right < domains.length; right += 1) {
      const leftDomain = domains[left] as UnionDomain
      const rightDomain = domains[right] as UnionDomain
      if (domainsOverlap(leftDomain, rightDomain)) return false
    }
  }
  return true
}

function domainOf(struct: RuntimeStruct): UnionDomain | undefined {
  const definition = struct[DEFINITION]
  const domain = domainOfKind(struct, definition)
  if (domain === undefined) return undefined
  return applyFlags(domain, definition)
}

function domainOfKind(
  struct: RuntimeStruct,
  definition: StructDefinition
): UnionDomain | undefined {
  switch (definition.kind) {
    case "any":
    case "unknown":
    case "or":
    case "discriminatedUnion":
    case "intersection":
    case "record":
    case "tuple":
      return undefined
    case "array":
      return domainOf(definition.item as RuntimeStruct) === undefined
        ? undefined
        : blankDomain({ arrays: true })
    case "enum":
      return domainOfEnum(definition)
    case "literal":
      return domainOfLiteral(definition.value)
    case "object":
      return domainOfObject(struct, definition)
    case "boolean":
    case "null":
    case "number":
    case "string":
    case "arrayBuffer":
    case "bigint":
    case "blob":
    case "date":
    case "file":
      return domainOfPrimitive(definition)
  }
}

function domainOfPrimitive(
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>
): UnionDomain | undefined {
  if (definition.decode !== undefined || definition.encode !== undefined) return undefined
  switch (definition.kind) {
    case "boolean":
      return blankDomain({ booleans: true })
    case "null":
      return blankDomain({ nulls: true })
    case "number":
      return blankDomain({ numbers: true })
    case "string":
      return blankDomain({ strings: true })
    default:
      return undefined
  }
}

function domainOfEnum(definition: EnumDefinition<string | number>): UnionDomain | undefined {
  const finite: UnionAtom[] = []
  for (const value of definition.values) {
    if (typeof value === "number" && Number.isNaN(value)) return undefined
    finite.push({ looseZero: typeof value === "number", value })
  }
  return blankDomain({ finite })
}

function domainOfLiteral(value: LiteralValue): UnionDomain {
  if (value === null) return blankDomain({ nulls: true })
  return blankDomain({ finite: [{ looseZero: false, value }] })
}

function domainOfObject(
  struct: RuntimeStruct,
  definition: ObjectDefinition
): UnionDomain | undefined {
  const descriptors = definition.cache.declaredDescriptors
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (descriptor !== undefined && typeof descriptor.get === "function") return undefined
  }
  for (const field of resolveStructFields(struct, definition)) {
    if (domainOf(field.struct) === undefined) return undefined
  }
  return blankDomain({ object: tagOf(struct, definition) ?? true })
}

function tagOf(struct: RuntimeStruct, definition: ObjectDefinition): ObjectTag | undefined {
  for (const field of resolveStructFields(struct, definition)) {
    const fieldDefinition = field.struct[DEFINITION]
    if (fieldDefinition.flags.optional || fieldDefinition.flags.nullable) continue
    if (fieldDefinition.kind === "literal") return { key: field.key, value: fieldDefinition.value }
  }
  return undefined
}

function blankDomain(partial: {
  arrays?: boolean
  booleans?: boolean
  finite?: readonly UnionAtom[]
  nulls?: boolean
  numbers?: boolean
  object?: ObjectTag | true
  strings?: boolean
}): UnionDomain {
  return {
    arrays: partial.arrays === true,
    booleans: partial.booleans === true,
    finite: partial.finite ?? [],
    nulls: partial.nulls === true,
    numbers: partial.numbers === true,
    object: partial.object,
    strings: partial.strings === true,
    undefs: false
  }
}

function applyFlags(domain: UnionDomain, definition: StructDefinition): UnionDomain {
  if (!definition.flags.nullable && !definition.flags.optional) return domain
  return {
    arrays: domain.arrays,
    booleans: domain.booleans,
    finite: domain.finite,
    nulls: domain.nulls || definition.flags.nullable,
    numbers: domain.numbers,
    object: domain.object,
    strings: domain.strings,
    undefs: domain.undefs || definition.flags.optional
  }
}

function domainsOverlap(left: UnionDomain, right: UnionDomain): boolean {
  if (left.nulls && right.nulls) return true
  if (left.undefs && right.undefs) return true
  if (left.strings && right.strings) return true
  if (left.numbers && right.numbers) return true
  if (left.booleans && right.booleans) return true
  if (left.arrays && right.arrays) return true
  if (left.strings && atomsHave(right.finite, "string")) return true
  if (right.strings && atomsHave(left.finite, "string")) return true
  if (left.numbers && atomsHaveNonNaNNumber(right.finite)) return true
  if (right.numbers && atomsHaveNonNaNNumber(left.finite)) return true
  if (left.booleans && atomsHave(right.finite, "boolean")) return true
  if (right.booleans && atomsHave(left.finite, "boolean")) return true
  if (objectsOverlap(left.object, right.object)) return true
  return atomsOverlap(left.finite, right.finite)
}

function atomsHave(atoms: readonly UnionAtom[], kind: "boolean" | "string"): boolean {
  for (const atom of atoms) {
    if (typeof atom.value === kind) return true
  }
  return false
}

function atomsHaveNonNaNNumber(atoms: readonly UnionAtom[]): boolean {
  for (const atom of atoms) {
    if (typeof atom.value === "number" && !Number.isNaN(atom.value)) return true
  }
  return false
}

function objectsOverlap(
  left: ObjectTag | true | undefined,
  right: ObjectTag | true | undefined
): boolean {
  if (left === undefined || right === undefined) return false
  if (left === true || right === true) return true
  if (left.key !== right.key) return true
  return Object.is(left.value, right.value)
}

function atomsOverlap(left: readonly UnionAtom[], right: readonly UnionAtom[]): boolean {
  for (const leftAtom of left) {
    for (const rightAtom of right) {
      if (atomPairOverlaps(leftAtom, rightAtom)) return true
    }
  }
  return false
}

function atomPairOverlaps(left: UnionAtom, right: UnionAtom): boolean {
  if (typeof left.value === "number" && typeof right.value === "number") {
    if (left.looseZero || right.looseZero) return left.value === right.value
    return Object.is(left.value, right.value)
  }
  return Object.is(left.value, right.value)
}
