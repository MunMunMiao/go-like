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
}

type JsonStep = (value: unknown, graph: EncodeGraph) => unknown

const INVALID: unique symbol = Symbol("struct.json.encode.invalid")
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
  const encoder = step === null ? null : bindRoot(step)
  roots.set(runtime, encoder)
  return encoder
}

function bindRoot(step: JsonStep): JsonEncoder {
  return (value) => {
    if (portableValueGraphError(value) !== undefined) return INVALID
    const graph: EncodeGraph = { active: new WeakSet(), depth: 0 }
    const container = valueContainer(value)
    if (container !== undefined) {
      graph.depth = 1
      graph.active.add(container)
    }
    return step(value, graph)
  }
}

function valueContainer(value: unknown): object | undefined {
  if (Array.isArray(value) || isPlainObject(value)) return value
  return undefined
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

function compileDefinition(struct: RuntimeStruct): JsonStep | null {
  const definition = struct[DEFINITION]
  if (definition.alias !== undefined) return null

  switch (definition.kind) {
    case "any":
    case "unknown":
      return compileChecked(definition, (value) =>
        portableValueGraphError(value) !== undefined ? INVALID : value
      )
    case "array":
      return compileArray(definition)
    case "enum":
      return compileEnum(definition)
    case "literal":
      return compileLiteral(definition)
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
      return compilePrimitive(definition)
    case "discriminatedUnion":
    case "intersection":
    case "or":
    case "record":
    case "tuple":
      return null
  }
}

function compileArray(definition: ArrayDefinition): JsonStep | null {
  const item = compileStep(definition.item as RuntimeStruct)
  if (item === null) return null
  const element = nested(item)
  return compileChecked(definition, (value, graph) => {
    if (!Array.isArray(value)) return INVALID
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const raw = readIndex(value, index)
      if (raw === INVALID) return INVALID
      const encoded = element(raw, graph)
      if (encoded === INVALID) return INVALID
      output.push(encoded)
    }
    return output
  })
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
  for (const field of resolveStructFields(struct, definition)) {
    const step = compileStep(field.struct)
    if (step === null) return null
    compiledFields.push({ key: field.key, step: nested(step) })
  }

  return compileChecked(definition, (value, graph) => {
    if (!isPlainObject(value)) return INVALID
    const output: { [key: string]: unknown } = Object.create(null)
    for (const field of compiledFields) {
      const raw = readOwn(value, field.key)
      if (raw === INVALID) return INVALID
      const encoded = field.step(raw, graph)
      if (encoded === INVALID) return INVALID
      if (encoded !== undefined) output[field.key] = encoded
    }
    return output
  })
}

function compilePrimitive(
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>
): JsonStep | null {
  if (definition.decode !== undefined || definition.encode !== undefined) return null
  const check = definition.is
  return compileChecked(definition, (value) => (check(value) ? value : INVALID))
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

function readOwn(value: { [key: string]: unknown }, key: string): unknown {
  if (!hasOwnKey(value, key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return INVALID
  return value[key]
}

function readIndex(value: unknown[], index: number): unknown {
  if (!Object.hasOwn(value, index)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, index)
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return INVALID
  return value[index]
}

function acceptsNull(definition: StructDefinition): boolean {
  if (definition.flags.nullable || definition.kind === "null") return true
  return definition.kind === "literal" && definition.value === null
}
