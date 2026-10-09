import { decodeObjectByAlias } from "./codec/common"
import { resolveStructFields } from "./fields"
import { isStruct } from "./guards"
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
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "./value-graph"

/** Happy-path JSON decoder. Unsupported schemas compile to null. */
export type JsonDecoder = (value: unknown) => unknown

const INVALID: unique symbol = Symbol("struct.json.invalid")
const compiled = new WeakMap<RuntimeStruct, JsonDecoder | null>()

/** Compiles a JSON decode fast path, or returns null when the schema must stay on the interpreter. */
export function compileJsonDecoder(struct: AnyStructLike): JsonDecoder | null {
  if (typeof struct === "object" && struct !== null) {
    const cached = compiled.get(struct as RuntimeStruct)
    if (cached !== undefined) return cached
  }
  if (!isStruct(struct)) return null
  return compileRuntime(struct as RuntimeStruct)
}

/** Decodes a JSON tree. A miss, a failure mark, or an over-deep tree reruns the alias interpreter. */
export function decodeCompiledJsonTree(struct: AnyStructLike, tree: unknown): unknown {
  const decoder = compileJsonDecoder(struct)
  // Null means the schema is not compilable, including a non-struct. Skip the depth walk.
  if (decoder === null) return decodeObjectByAlias(struct, tree)
  if (jsonTreeExceedsPortableDepth(tree)) return decodeObjectByAlias(struct, tree)
  const decoded = decoder(tree)
  if (decoded === INVALID) return decodeObjectByAlias(struct, tree)
  return decoded
}

// JSON.parse trees have no cycles and only enumerable data properties, so a
// container-depth walk matches portableValueGraphError without descriptor or cycle checks.
function jsonTreeExceedsPortableDepth(value: unknown): boolean {
  const values: unknown[] = [value]
  const depths: number[] = [0]
  while (values.length > 0) {
    const frameValue = values.pop()
    const frameDepth = depths.pop() as number
    if (!Array.isArray(frameValue) && !isPlainObject(frameValue)) continue
    const depth = frameDepth + 1
    if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) return true
    const container = frameValue as { [key: string]: unknown }
    const keys = Object.keys(container)
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      values.push(container[keys[index] as string])
      depths.push(depth)
    }
  }
  return false
}

function compileRuntime(struct: RuntimeStruct): JsonDecoder | null {
  const cached = compiled.get(struct)
  if (cached !== undefined) return cached
  const decoder = compileDefinition(struct)
  compiled.set(struct, decoder)
  return decoder
}

function compileDefinition(struct: RuntimeStruct): JsonDecoder | null {
  const definition = struct[DEFINITION]
  if (definition.alias !== undefined) return null

  switch (definition.kind) {
    case "any":
    case "unknown":
      // Root graph checks already cover JSON trees, so any/unknown is identity.
      return compileChecked(definition, (value) => value)
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

function compileArray(definition: ArrayDefinition): JsonDecoder | null {
  const item = compileRuntime(definition.item as RuntimeStruct)
  if (item === null) return null
  return compileChecked(definition, (value) => {
    if (!Array.isArray(value)) return INVALID
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const decoded = item(value[index])
      if (decoded === INVALID) return INVALID
      output.push(decoded)
    }
    return output
  })
}

function compileEnum(definition: EnumDefinition<string | number>): JsonDecoder {
  return compileChecked(definition, (value) => (matchesEnum(definition, value) ? value : INVALID))
}

function compileLiteral(definition: LiteralDefinition<LiteralValue>): JsonDecoder {
  const expected = definition.value
  return compileChecked(definition, (value) => (Object.is(value, expected) ? value : INVALID))
}

function compileObject(struct: RuntimeStruct, definition: ObjectDefinition): JsonDecoder | null {
  const descriptors = definition.cache.declaredDescriptors
  for (const key of Object.keys(descriptors)) {
    if (typeof descriptors[key]?.get === "function") return null
  }

  const fields = resolveStructFields(struct, definition)
  const compiledFields: Array<{
    decode: JsonDecoder
    key: string
    wireKey: string
  }> = []
  for (const field of fields) {
    const decode = compileRuntime(field.struct)
    if (decode === null) return null
    compiledFields.push({ decode, key: field.key, wireKey: field.wireKey })
  }

  return compileChecked(definition, (value) => {
    if (!isPlainObject(value)) return INVALID
    const output: { [key: string]: unknown } = Object.create(null)
    for (const field of compiledFields) {
      const raw = hasOwnKey(value, field.wireKey) ? value[field.wireKey] : undefined
      const decoded = field.decode(raw)
      if (decoded === INVALID) return INVALID
      if (decoded !== undefined) output[field.key] = decoded
    }
    return output
  })
}

function compilePrimitive(
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>
): JsonDecoder | null {
  if (definition.decode !== undefined || definition.encode !== undefined) return null
  const check = definition.is
  return compileChecked(definition, (value) => (check(value) ? value : INVALID))
}

function compileChecked(
  definition: StructDefinition,
  accept: (value: unknown) => unknown
): JsonDecoder {
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  return (value) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) return nullOk ? null : INVALID
    return accept(value)
  }
}

function acceptsNull(definition: StructDefinition): boolean {
  if (definition.flags.nullable || definition.kind === "null") return true
  return definition.kind === "literal" && definition.value === null
}
