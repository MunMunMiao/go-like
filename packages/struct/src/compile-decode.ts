import { decodeObjectByAlias } from "./codec/common"
import { StructError } from "./errors"
import { resolveStructFields } from "./fields"
import { isStruct } from "./guards"
import { parseStructQuiet } from "./parse"
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
  RuntimeStruct,
  StructDefinition,
  UnionDefinition
} from "./types"
import { hasOwnKey, isPlainObject, matchesEnum } from "./utils"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "./value-graph"

/** Happy-path JSON decoder. A non-struct compiles to null. */
export type JsonDecoder = (value: unknown) => unknown

const INVALID: unique symbol = Symbol("struct.json.invalid")
const compiled = new WeakMap<RuntimeStruct, JsonDecoder | null>()
const steps = new WeakMap<RuntimeStruct, CompiledStep | null>()

type FieldCache = { readonly value: unknown; readonly wireKey: string }
type PureStep = (value: unknown, cache?: FieldCache) => unknown
type PathStep = (value: unknown, path: Path, cache?: FieldCache) => unknown

// needsPath means this step or a descendant is an island. Pure steps never allocate or update a path.
// cached is the object step that can reuse a discriminated-union field. The fast run does not.
type CompiledStep =
  | { readonly cached: PureStep | undefined; readonly needsPath: false; readonly run: PureStep }
  | { readonly needsPath: true; readonly run: PathStep }

type CompiledField = {
  key: string
  optional: boolean
  step: CompiledStep
  wireKey: string
}

/** Compiles a JSON decode fast path. Non-structs stay null. */
export function compileJsonDecoder(struct: AnyStructLike): JsonDecoder | null {
  if (typeof struct === "object" && struct !== null) {
    const cached = compiled.get(struct as RuntimeStruct)
    if (cached !== undefined) return cached
  }
  if (!isStruct(struct)) return null
  const runtime = struct as RuntimeStruct
  const step = compileStep(runtime)
  if (step === null) {
    compiled.set(runtime, null)
    return null
  }
  const decoder: JsonDecoder = step.needsPath ? (value) => step.run(value, []) : step.run
  compiled.set(runtime, decoder)
  return decoder
}

/** Decodes a JSON tree. A miss, a failure mark, or an over-deep tree reruns the alias interpreter. */
export function decodeCompiledJsonTree(struct: AnyStructLike, tree: unknown): unknown {
  const decoder = compileJsonDecoder(struct)
  // Null means a non-struct, or a schema with a lazy field. Skip the depth walk.
  if (decoder === null) return decodeObjectByAlias(struct, tree)
  if (jsonTreeExceedsPortableDepth(tree)) return decodeObjectByAlias(struct, tree)
  const decoded = decoder(tree)
  // An island decode hook that already succeeded runs again when INVALID falls back
  // to the interpreter. That rerun is still the only source of StructError.
  if (decoded === INVALID) return decodeObjectByAlias(struct, tree)
  return decoded
}

// JSON.parse trees have no cycles and only enumerable data properties, so a
// container-depth walk matches portableValueGraphError without descriptor or cycle checks.
// A cycle still stops: past the depth limit the interpreter reports the same StructError as decodeJson.
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

function compileStep(struct: RuntimeStruct): CompiledStep | null {
  if (steps.has(struct)) return steps.get(struct) ?? null
  const step = compileDefinition(struct)
  steps.set(struct, step)
  return step
}

function compileDefinition(struct: RuntimeStruct): CompiledStep | null {
  const definition = struct[DEFINITION]
  switch (definition.kind) {
    case "any":
    case "unknown":
      // Root graph checks already cover JSON trees, so any/unknown is identity.
      return pure(compileChecked(definition, (value) => value))
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
      return compilePrimitive(struct, definition)
    case "discriminatedUnion":
      return compileDiscriminatedUnion(definition)
    case "or":
      return compileOr(definition)
    case "intersection":
      return compileIsland(struct, definition.options as unknown as readonly RuntimeStruct[])
    case "record":
      return compileIsland(struct, [definition.value as RuntimeStruct])
    case "tuple":
      return compileIsland(struct, definition.items as unknown as readonly RuntimeStruct[])
  }
}

function pure(run: PureStep): CompiledStep {
  return { cached: undefined, needsPath: false, run }
}

function compileArray(definition: ArrayDefinition): CompiledStep | null {
  const item = compileStep(definition.item as RuntimeStruct)
  if (item === null) return null
  if (!item.needsPath) {
    const run = item.run
    return pure(
      compileChecked(definition, (value) => {
        if (!Array.isArray(value)) return INVALID
        const output: unknown[] = []
        for (let index = 0; index < value.length; index += 1) {
          const decoded = run(value[index])
          if (decoded === INVALID) return INVALID
          output.push(decoded)
        }
        return output
      })
    )
  }
  return {
    needsPath: true,
    run: compileCheckedPath(definition, (value, path) => {
      if (!Array.isArray(value)) return INVALID
      const output: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        path.push(index)
        let decoded: unknown
        try {
          decoded = item.run(value[index], path)
        } finally {
          path.pop()
        }
        if (decoded === INVALID) return INVALID
        output.push(decoded)
      }
      return output
    })
  }
}

function compileEnum(definition: EnumDefinition<string | number>): CompiledStep {
  return pure(
    compileChecked(definition, (value) => (matchesEnum(definition, value) ? value : INVALID))
  )
}

function compileLiteral(definition: LiteralDefinition<LiteralValue>): CompiledStep {
  const expected = definition.value
  return pure(compileChecked(definition, (value) => (Object.is(value, expected) ? value : INVALID)))
}

function compileObject(struct: RuntimeStruct, definition: ObjectDefinition): CompiledStep | null {
  for (const descriptor of Object.values(definition.cache.declaredDescriptors)) {
    // Calling the getter here would run it outside the interpreter's error catch.
    if (typeof descriptor?.get === "function") return null
  }
  const compiledFields: CompiledField[] = []
  let needsPath = false
  for (const field of resolveStructFields(struct, definition)) {
    const step = compileStep(field.struct)
    if (step === null) return null
    if (step.needsPath) needsPath = true
    compiledFields.push({
      key: field.key,
      optional: field.struct[DEFINITION].flags.optional,
      step,
      wireKey: field.wireKey
    })
  }
  if (!needsPath) {
    const built = compilePureObject(definition, compiledFields)
    return { cached: built.cached, needsPath: false, run: built.run }
  }
  return { needsPath: true, run: compilePathObject(definition, compiledFields) }
}

function compilePureObject(
  definition: ObjectDefinition,
  compiledFields: readonly CompiledField[]
): { cached: PureStep; run: PureStep } {
  const fields: Array<{ key: string; run: PureStep; wireKey: string }> = []
  for (const field of compiledFields) {
    if (!field.step.needsPath)
      fields.push({ key: field.key, run: field.step.run, wireKey: field.wireKey })
  }
  const run = compileChecked(definition, (value) => {
    if (!isPlainObject(value)) return INVALID
    const output: { [key: string]: unknown } = Object.create(null)
    for (const field of fields) {
      const raw = hasOwnKey(value, field.wireKey) ? value[field.wireKey] : undefined
      const decoded = field.run(raw)
      if (decoded === INVALID) return INVALID
      if (decoded !== undefined) output[field.key] = decoded
    }
    return output
  })
  const cached = compileCheckedCached(definition, (value, cache) => {
    if (!isPlainObject(value)) return INVALID
    const output: { [key: string]: unknown } = Object.create(null)
    for (const field of fields) {
      const raw =
        cache !== undefined && cache.wireKey === field.wireKey
          ? cache.value
          : hasOwnKey(value, field.wireKey)
            ? value[field.wireKey]
            : undefined
      const decoded = field.run(raw)
      if (decoded === INVALID) return INVALID
      if (decoded !== undefined) output[field.key] = decoded
    }
    return output
  })
  return { cached, run }
}

function compilePathObject(
  definition: ObjectDefinition,
  compiledFields: readonly CompiledField[]
): PathStep {
  return compileCheckedPath(definition, (value, path, cache) => {
    if (!isPlainObject(value)) return INVALID
    const output: { [key: string]: unknown } = Object.create(null)
    for (const field of compiledFields) {
      const raw =
        cache !== undefined && cache.wireKey === field.wireKey
          ? cache.value
          : hasOwnKey(value, field.wireKey)
            ? value[field.wireKey]
            : undefined
      if (raw === undefined) {
        if (field.optional) continue
        return INVALID
      }
      let decoded: unknown
      if (field.step.needsPath) {
        path.push(field.key)
        try {
          decoded = field.step.run(raw, path)
        } finally {
          path.pop()
        }
      } else decoded = field.step.run(raw)
      if (decoded === INVALID) return INVALID
      output[field.key] = decoded
    }
    return output
  })
}

function compilePrimitive(
  struct: RuntimeStruct,
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>
): CompiledStep {
  if (definition.decode !== undefined || definition.encode !== undefined) return islandStep(struct)
  const check = definition.is
  return pure(compileChecked(definition, (value) => (check(value) ? value : INVALID)))
}

function compileOr(definition: UnionDefinition): CompiledStep | null {
  const options: CompiledStep[] = []
  let needsPath = false
  for (const option of definition.options) {
    const step = compileStep(option as RuntimeStruct)
    if (step === null) return null
    if (step.needsPath) needsPath = true
    options.push(step)
  }
  const optional = definition.flags.optional
  const nullable = definition.flags.nullable
  if (!needsPath) {
    const pureOptions: PureStep[] = []
    for (const option of options) {
      if (!option.needsPath) pureOptions.push(option.run)
    }
    return pure((value) => {
      if (value === undefined) return optional ? undefined : INVALID
      if (value === null && nullable) return null
      for (const option of pureOptions) {
        const decoded = option(value)
        if (decoded !== INVALID) return decoded
      }
      return INVALID
    })
  }
  return {
    needsPath: true,
    run: (value, path) => {
      if (value === undefined) return optional ? undefined : INVALID
      if (value === null && nullable) return null
      for (const option of options) {
        const decoded = option.needsPath ? option.run(value, path) : option.run(value)
        if (decoded !== INVALID) return decoded
      }
      return INVALID
    }
  }
}

function compileDiscriminatedUnion(definition: DiscriminatedUnionDefinition): CompiledStep | null {
  const wireKeys = definition.discriminatorWireKeys as readonly string[]
  const wireKeyByValue = definition.wireKeyByValue as Map<unknown, string>
  const optionSteps = new Map<unknown, CompiledStep>()
  let needsPath = false
  for (const [discriminator, option] of definition.map) {
    const step = compileStep(option as RuntimeStruct)
    if (step === null) return null
    if (step.needsPath) needsPath = true
    optionSteps.set(discriminator, step)
  }
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  if (!needsPath) {
    const pureSteps = new Map<unknown, PureStep>()
    for (const [discriminator, step] of optionSteps) {
      if (!step.needsPath && step.cached !== undefined) pureSteps.set(discriminator, step.cached)
    }
    return pure((value) =>
      readDiscriminated(
        value,
        wireKeys,
        wireKeyByValue,
        optional,
        nullOk,
        (discriminator, wireKey) => {
          const step = pureSteps.get(discriminator)
          if (step === undefined || wireKeyByValue.get(discriminator) !== wireKey) return INVALID
          return step(value, { value: discriminator, wireKey })
        }
      )
    )
  }
  return {
    needsPath: true,
    run: (value, path) =>
      readDiscriminated(
        value,
        wireKeys,
        wireKeyByValue,
        optional,
        nullOk,
        (discriminator, wireKey) => {
          const step = optionSteps.get(discriminator)
          if (step === undefined || wireKeyByValue.get(discriminator) !== wireKey) return INVALID
          const cache: FieldCache = { value: discriminator, wireKey }
          if (step.needsPath) return step.run(value, path, cache)
          return (step.cached ?? step.run)(value, cache)
        }
      )
  }
}

function readDiscriminated(
  value: unknown,
  wireKeys: readonly string[],
  wireKeyByValue: Map<unknown, string>,
  optional: boolean,
  nullOk: boolean,
  finish: (discriminator: unknown, wireKey: string) => unknown
): unknown {
  if (value === undefined) return optional ? undefined : INVALID
  if (value === null) return nullOk ? null : INVALID
  if (!isPlainObject(value)) return INVALID
  for (const wireKey of wireKeys) {
    if (!hasOwnKey(value, wireKey)) continue
    const discriminator = value[wireKey]
    if (discriminator === undefined) return INVALID
    if (wireKeyByValue.get(discriminator) !== wireKey) return INVALID
    return finish(discriminator, wireKey)
  }
  return INVALID
}

function compileIsland(
  struct: RuntimeStruct,
  children: readonly RuntimeStruct[]
): CompiledStep | null {
  for (const child of children) {
    if (compileStep(child) === null) return null
  }
  return islandStep(struct)
}

// Subtree parse uses value mode and aliases. Object fields omit a missing optional
// before this runs, so an OMIT symbol never has to cross the compiled parent.
function islandStep(struct: RuntimeStruct): CompiledStep {
  const definition = struct[DEFINITION]
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  const passNull = definition.kind === "or" || definition.kind === "intersection"
  return {
    needsPath: true,
    run: (value, path) => {
      if (value === undefined) return optional ? undefined : INVALID
      if (value === null && nullOk) return null
      if (value === null && !passNull) return INVALID
      try {
        const result = parseStructQuiet(struct, value, path)
        if (!result.ok) return INVALID
        return result.value
      } catch (error) {
        if (error instanceof StructError) return INVALID
        throw error
      }
    }
  }
}

function compileChecked(
  definition: StructDefinition,
  accept: (value: unknown) => unknown
): PureStep {
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  return (value) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) return nullOk ? null : INVALID
    return accept(value)
  }
}

function compileCheckedCached(
  definition: StructDefinition,
  accept: (value: unknown, cache?: FieldCache) => unknown
): PureStep {
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  return (value, cache) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) return nullOk ? null : INVALID
    return accept(value, cache)
  }
}

function compileCheckedPath(
  definition: StructDefinition,
  accept: (value: unknown, path: Path, cache?: FieldCache) => unknown
): PathStep {
  const optional = definition.flags.optional
  const nullOk = acceptsNull(definition)
  return (value, path, cache) => {
    if (value === undefined) return optional ? undefined : INVALID
    if (value === null) return nullOk ? null : INVALID
    return accept(value, path, cache)
  }
}

function acceptsNull(definition: StructDefinition): boolean {
  if (definition.flags.nullable || definition.kind === "null") return true
  return definition.kind === "literal" && definition.value === null
}
