import { hasErrorMap, issue, StructError } from "./errors"
import { resolveStructFields, type ResolvedStructField } from "./fields"
import { DEFINITION, OMIT } from "./symbols"
import type {
  ArrayDefinition,
  DiscriminatedUnionDefinition,
  EnumDefinition,
  InternalParseResult,
  IntersectionDefinition,
  LiteralDefinition,
  LiteralValue,
  ObjectDefinition,
  ParseMode,
  ParseFailure,
  Path,
  PrimitiveDefinition,
  PrimitiveKind,
  RecordDefinition,
  RuntimeStruct,
  StructIssue,
  TupleDefinition,
  UnionDefinition
} from "./types"
import { expectedType, failure, hasOwnKey, isPlainObject, matchesEnum, success } from "./utils"
import {
  foldIntersectionResults,
  mergePlainObjects,
  portableValueGraphError,
  PORTABLE_VALUE_GRAPH_DEPTH_LIMIT
} from "./value-graph"

// Failed union candidates are discarded. Public entry points always request detailed issues.
const QUIET_FAILURE: ParseFailure = {
  ok: false,
  issue: { code: "invalid_union", expected: "", message: "", path: [], received: undefined }
}

interface ParseGraph {
  readonly active: WeakSet<object>
  depth: number
}

const parseGraphs: ParseGraph[] = []

function valueContainer(value: unknown): object | undefined {
  if (Array.isArray(value) || isPlainObject(value)) {
    return value
  }
  return undefined
}

function graphFailure(path: Path, input: unknown, message: string): InternalParseResult<never> {
  return failure(issue([...path], "custom", "safe struct value graph", input, message))
}

function withParseGraph<T>(
  input: unknown,
  run: () => InternalParseResult<T>
): InternalParseResult<T> {
  parseGraphs.push({ active: new WeakSet(), depth: 0 })
  try {
    return enterRoot(input, run)
  } finally {
    parseGraphs.pop()
  }
}

function enterRoot<T>(input: unknown, run: () => InternalParseResult<T>): InternalParseResult<T> {
  const container = valueContainer(input)
  if (container === undefined) {
    return run()
  }
  const graph = parseGraphs[parseGraphs.length - 1] as ParseGraph
  graph.depth = 1
  graph.active.add(container)
  try {
    return run()
  } finally {
    graph.active.delete(container)
    graph.depth = 0
  }
}

export function parseValue(
  struct: RuntimeStruct,
  input: unknown,
  path: Path,
  mode: ParseMode,
  useAliases = false
): InternalParseResult<unknown> {
  return withParseGraph(input, () => drive(struct, input, [...path], mode, useAliases, true))
}

export function parseRootValue(
  struct: RuntimeStruct,
  input: unknown,
  mode: ParseMode,
  useAliases = false
): InternalParseResult<unknown> {
  return withParseGraph(input, () => drive(struct, input, [], mode, useAliases, true))
}

/** Island probe. `reportIssues` is false so a miss reuses QUIET_FAILURE instead of allocating an issue. */
export function parseStructQuiet(
  struct: RuntimeStruct,
  input: unknown,
  path: Path
): InternalParseResult<unknown> {
  return withParseGraph(input, () => drive(struct, input, [...path], "value", true, false))
}

type ParsePhase = "array" | "intersection" | "object" | "record" | "tuple" | "union"
type ParseStart = "object" | "value"

interface ParseFrame {
  cached: { inputKey: string; value: unknown } | undefined
  container: object | undefined
  entered: boolean
  fields: readonly ResolvedStructField[] | undefined
  index: number
  input: unknown
  keys: readonly string[] | undefined
  mode: ParseMode
  objectSides: boolean
  opened: boolean
  output: unknown
  pathPushed: boolean
  phase: ParsePhase
  reportIssues: boolean
  segment: number | string | undefined
  sides: unknown[] | undefined
  sink: { [key: string]: unknown } | undefined
  start: ParseStart
  struct: RuntimeStruct
  useAliases: boolean
  waiting: boolean
}

interface ParseBox {
  result: InternalParseResult<unknown>
}

// Heap frames keep nested or() and discriminatedUnion() off the JavaScript stack.
function drive(
  struct: RuntimeStruct,
  input: unknown,
  path: Path,
  mode: ParseMode,
  useAliases: boolean,
  reportIssues: boolean
): InternalParseResult<unknown> {
  const box: ParseBox = { result: success(undefined) }
  const frames: ParseFrame[] = [
    parseFrame(struct, input, mode, useAliases, reportIssues, undefined, "value", undefined)
  ]
  while (frames.length > 0) {
    const frame = frames[frames.length - 1] as ParseFrame
    if (!frame.opened) openFrame(frame, frames, path, box)
    else stepFrame(frame, frames, path, box)
  }
  return box.result
}

function parseFrame(
  struct: RuntimeStruct,
  input: unknown,
  mode: ParseMode,
  useAliases: boolean,
  reportIssues: boolean,
  segment: number | string | undefined,
  start: ParseStart,
  sink: { [key: string]: unknown } | undefined
): ParseFrame {
  return {
    cached: undefined,
    container: undefined,
    entered: false,
    fields: undefined,
    index: 0,
    input,
    keys: undefined,
    mode,
    objectSides: false,
    opened: false,
    output: undefined,
    pathPushed: false,
    phase: "union",
    reportIssues,
    segment,
    sides: undefined,
    sink,
    start,
    struct,
    useAliases,
    waiting: false
  }
}

function reject(
  reportIssues: boolean,
  path: Path,
  code: StructIssue["code"],
  expected: string,
  received: unknown
): InternalParseResult<never> {
  if (!reportIssues) return QUIET_FAILURE
  return failure(issue([...path], code, expected, received))
}

function unionIsWaiting(frames: readonly ParseFrame[]): boolean {
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as ParseFrame
    if (frame.phase === "union" && frame.waiting) return true
  }
  return false
}

function finish(
  frames: ParseFrame[],
  path: Path,
  box: ParseBox,
  result: InternalParseResult<unknown>
): void {
  const frame = frames.pop() as ParseFrame
  if (frame.entered && frame.container !== undefined) {
    const graph = parseGraphs[parseGraphs.length - 1] as ParseGraph
    graph.active.delete(frame.container)
    graph.depth -= 1
  }
  if (frame.pathPushed) path.pop()
  box.result = result
}

function openFrame(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  if (frame.segment !== undefined) {
    path.push(frame.segment)
    frame.pathPushed = true
    const container = valueContainer(frame.input)
    frame.container = container
    if (container !== undefined) {
      const graph = parseGraphs[parseGraphs.length - 1] as ParseGraph
      const depth = graph.depth + 1
      if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) {
        finish(
          frames,
          path,
          box,
          graphFailure(
            path,
            frame.input,
            `struct value exceeds portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
          )
        )
        return
      }
      if (graph.active.has(container)) {
        finish(frames, path, box, graphFailure(path, frame.input, "struct value contains a cycle"))
        return
      }
      graph.depth = depth
      graph.active.add(container)
      frame.entered = true
    }
  }
  frame.opened = true
  if (frame.start === "object") beginObject(frame, frames, path, box)
  else beginValue(frame, frames, path, box)
}

function beginValue(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION]
  const input = frame.input
  if (input === undefined) {
    if (definition.flags.optional) {
      finish(frames, path, box, success(frame.mode === "field" ? OMIT : undefined))
      return
    }
    finish(
      frames,
      path,
      box,
      reject(
        frame.reportIssues,
        path,
        frame.mode === "field" ? "missing_key" : "invalid_type",
        expectedType(definition),
        input
      )
    )
    return
  }
  if (input === null) {
    if (definition.kind === "null" || definition.flags.nullable) {
      finish(frames, path, box, success(null))
      return
    }
    const delegatesNull =
      (definition.kind === "literal" && definition.value === null) ||
      definition.kind === "intersection" ||
      definition.kind === "or"
    if (!delegatesNull) {
      finish(
        frames,
        path,
        box,
        reject(frame.reportIssues, path, "invalid_type", expectedType(definition), input)
      )
      return
    }
  }

  switch (definition.kind) {
    case "any":
    case "unknown": {
      const message = portableValueGraphError(input)
      finish(
        frames,
        path,
        box,
        message !== undefined ? graphFailure(path, input, message) : success(input)
      )
      return
    }
    case "array":
      beginArray(frame, frames, path, box)
      return
    case "arrayBuffer":
    case "bigint":
    case "blob":
    case "boolean":
    case "date":
    case "file":
    case "null":
    case "number":
    case "string":
      finish(frames, path, box, parsePrimitiveValue(definition, input, path, frame.reportIssues))
      return
    case "enum":
      finish(frames, path, box, parseEnumValue(definition, input, path, frame.reportIssues))
      return
    case "intersection":
      beginIntersection(frame)
      return
    case "literal":
      finish(frames, path, box, parseLiteralValue(definition, input, path, frame.reportIssues))
      return
    case "object":
      beginObject(frame, frames, path, box)
      return
    case "or":
      frame.phase = "union"
      frame.index = 0
      frame.waiting = false
      return
    case "discriminatedUnion": {
      const resolved = resolveDiscriminatedTarget(
        definition,
        input,
        path,
        frame.useAliases,
        frame.reportIssues
      )
      if (!("matched" in resolved)) {
        finish(frames, path, box, resolved)
        return
      }
      frame.struct = resolved.runtime
      frame.cached = resolved.cached
      beginObject(frame, frames, path, box)
      return
    }
    case "record":
      beginRecord(frame, frames, path, box)
      return
    case "tuple":
      beginTuple(frame, frames, path, box)
      return
  }
}

function beginObject(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION] as ObjectDefinition
  if (!isPlainObject(frame.input)) {
    finish(
      frames,
      path,
      box,
      reject(frame.reportIssues, path, "invalid_type", "object", frame.input)
    )
    return
  }
  frame.phase = "object"
  frame.output = frame.sink ?? Object.create(null)
  frame.fields = resolveStructFields(frame.struct, definition)
  frame.index = 0
  frame.waiting = false
}

function beginArray(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  if (!Array.isArray(frame.input)) {
    finish(
      frames,
      path,
      box,
      reject(frame.reportIssues, path, "invalid_type", "array", frame.input)
    )
    return
  }
  frame.phase = "array"
  frame.output = []
  frame.index = 0
  frame.waiting = false
}

function beginTuple(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION] as TupleDefinition
  if (!Array.isArray(frame.input) || frame.input.length !== definition.items.length) {
    finish(
      frames,
      path,
      box,
      reject(
        frame.reportIssues,
        path,
        "invalid_type",
        `tuple of length ${definition.items.length}`,
        frame.input
      )
    )
    return
  }
  frame.phase = "tuple"
  frame.output = []
  frame.index = 0
  frame.waiting = false
}

function beginRecord(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  if (!isPlainObject(frame.input)) {
    finish(
      frames,
      path,
      box,
      reject(frame.reportIssues, path, "invalid_type", "record", frame.input)
    )
    return
  }
  frame.phase = "record"
  frame.output = Object.create(null)
  frame.keys = Object.keys(frame.input)
  frame.index = 0
  frame.waiting = false
}

function beginIntersection(frame: ParseFrame): void {
  const definition = frame.struct[DEFINITION] as IntersectionDefinition
  const objectSides = definition.objectSides && isPlainObject(frame.input)
  frame.phase = "intersection"
  frame.objectSides = objectSides
  frame.index = 0
  frame.waiting = false
  frame.sides = objectSides ? undefined : []
  if (objectSides) frame.output = Object.create(null)
}

function stepFrame(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  switch (frame.phase) {
    case "array":
      stepArray(frame, frames, path, box)
      return
    case "intersection":
      stepIntersection(frame, frames, path, box)
      return
    case "object":
      stepObject(frame, frames, path, box)
      return
    case "record":
      stepRecord(frame, frames, path, box)
      return
    case "tuple":
      stepTuple(frame, frames, path, box)
      return
    case "union":
      stepUnion(frame, frames, path, box)
      return
  }
}

function stepUnion(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION] as UnionDefinition
  if (frame.waiting) {
    frame.waiting = false
    if (box.result.ok) {
      finish(frames, path, box, box.result)
      return
    }
    frame.index += 1
  }
  const option = definition.options[frame.index] as RuntimeStruct | undefined
  if (option === undefined) {
    finish(
      frames,
      path,
      box,
      reject(frame.reportIssues, path, "invalid_union", definition.expected, frame.input)
    )
    return
  }
  frame.waiting = true
  frames.push(
    parseFrame(
      option,
      frame.input,
      "value",
      frame.useAliases,
      frame.reportIssues && hasErrorMap(),
      undefined,
      "value",
      undefined
    )
  )
}

function stepObject(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const fields = frame.fields as readonly ResolvedStructField[]
  if (frame.waiting) {
    frame.waiting = false
    if (!box.result.ok) {
      finish(frames, path, box, box.result)
      return
    }
    if (box.result.value !== OMIT) {
      const field = fields[frame.index] as ResolvedStructField
      const output = frame.output as { [key: string]: unknown }
      // A failed merge drops this union candidate. Outside a union it stays a StructError.
      try {
        output[field.key] = mergePlainObjects(output[field.key], box.result.value)
      } catch (error) {
        if (error instanceof StructError && unionIsWaiting(frames)) {
          finish(frames, path, box, QUIET_FAILURE)
          return
        }
        throw error
      }
    }
    frame.index += 1
  }
  if (frame.index >= fields.length) {
    finish(frames, path, box, success(frame.output))
    return
  }
  const field = fields[frame.index] as ResolvedStructField
  const input = frame.input as { [key: string]: unknown }
  const inputKey = frame.useAliases ? field.wireKey : field.key
  const inputValue =
    frame.cached !== undefined && frame.cached.inputKey === inputKey
      ? frame.cached.value
      : hasOwnKey(input, inputKey)
        ? input[inputKey]
        : undefined
  frame.waiting = true
  frames.push(
    parseFrame(
      field.struct,
      inputValue,
      "field",
      frame.useAliases,
      frame.reportIssues,
      field.key,
      "value",
      undefined
    )
  )
}

function stepArray(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION] as ArrayDefinition
  const input = frame.input as unknown[]
  const output = frame.output as unknown[]
  if (frame.waiting) {
    frame.waiting = false
    if (!box.result.ok) {
      finish(frames, path, box, box.result)
      return
    }
    output.push(box.result.value)
    frame.index += 1
  }
  if (frame.index >= input.length) {
    finish(frames, path, box, success(output))
    return
  }
  frame.waiting = true
  frames.push(
    parseFrame(
      definition.item as RuntimeStruct,
      input[frame.index],
      "value",
      frame.useAliases,
      frame.reportIssues,
      frame.index,
      "value",
      undefined
    )
  )
}

function stepTuple(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION] as TupleDefinition
  const input = frame.input as unknown[]
  const output = frame.output as unknown[]
  if (frame.waiting) {
    frame.waiting = false
    if (!box.result.ok) {
      finish(frames, path, box, box.result)
      return
    }
    output.push(box.result.value)
    frame.index += 1
  }
  if (frame.index >= definition.items.length) {
    finish(frames, path, box, success(output))
    return
  }
  frame.waiting = true
  frames.push(
    parseFrame(
      definition.items[frame.index] as RuntimeStruct,
      input[frame.index],
      "value",
      frame.useAliases,
      frame.reportIssues,
      frame.index,
      "value",
      undefined
    )
  )
}

function stepRecord(frame: ParseFrame, frames: ParseFrame[], path: Path, box: ParseBox): void {
  const definition = frame.struct[DEFINITION] as RecordDefinition
  const input = frame.input as { [key: string]: unknown }
  const keys = frame.keys as readonly string[]
  const output = frame.output as { [key: string]: unknown }
  if (frame.waiting) {
    frame.waiting = false
    if (!box.result.ok) {
      finish(frames, path, box, box.result)
      return
    }
    if (box.result.value !== OMIT) output[keys[frame.index] as string] = box.result.value
    frame.index += 1
  }
  if (frame.index >= keys.length) {
    finish(frames, path, box, success(output))
    return
  }
  const key = keys[frame.index] as string
  frame.waiting = true
  frames.push(
    parseFrame(
      definition.value as RuntimeStruct,
      input[key],
      "field",
      frame.useAliases,
      frame.reportIssues,
      key,
      "value",
      undefined
    )
  )
}

function stepIntersection(
  frame: ParseFrame,
  frames: ParseFrame[],
  path: Path,
  box: ParseBox
): void {
  const definition = frame.struct[DEFINITION] as IntersectionDefinition
  if (frame.waiting) {
    frame.waiting = false
    if (!box.result.ok) {
      finish(frames, path, box, box.result)
      return
    }
    if (!frame.objectSides) frame.sides?.push(box.result.value)
    frame.index += 1
  }
  if (frame.index >= definition.options.length) {
    if (frame.objectSides) {
      finish(frames, path, box, success(frame.output))
      return
    }
    try {
      finish(
        frames,
        path,
        box,
        success(foldIntersectionResults(frame.sides ?? [], frame.input, frame.useAliases))
      )
    } catch (error) {
      if (error instanceof StructError && unionIsWaiting(frames)) {
        finish(frames, path, box, QUIET_FAILURE)
        return
      }
      throw error
    }
    return
  }
  const option = definition.options[frame.index] as RuntimeStruct
  frame.waiting = true
  frames.push(
    parseFrame(
      option,
      frame.input,
      "value",
      frame.useAliases,
      frame.reportIssues,
      undefined,
      frame.objectSides ? "object" : "value",
      frame.objectSides ? (frame.output as { [key: string]: unknown }) : undefined
    )
  )
}

function parsePrimitiveValue(
  definition: PrimitiveDefinition<PrimitiveKind, unknown, unknown>,
  input: unknown,
  path: Path,
  reportIssues: boolean
): InternalParseResult<unknown> {
  if (!definition.is(input)) {
    return reportIssues
      ? failure(issue([...path], "invalid_type", definition.expected, input))
      : QUIET_FAILURE
  }

  return definition.decode ? definition.decode(input, [...path]) : success(input)
}

function parseEnumValue(
  definition: EnumDefinition<string | number>,
  input: unknown,
  path: Path,
  reportIssues: boolean
): InternalParseResult<unknown> {
  // Type boundary: enum structs are defined with string or number literals; by the time we reach this
  // parser the input has already been validated as non-null/undefined and only enum members can match.
  return matchesEnum(definition, input)
    ? success(input)
    : reportIssues
      ? failure(issue([...path], "invalid_enum", definition.expected, input))
      : QUIET_FAILURE
}

function parseLiteralValue(
  definition: LiteralDefinition<LiteralValue>,
  input: unknown,
  path: Path,
  reportIssues: boolean
): InternalParseResult<unknown> {
  return Object.is(input, definition.value)
    ? success(input)
    : reportIssues
      ? failure(issue([...path], "invalid_literal", definition.expected, input))
      : QUIET_FAILURE
}

/** Resolves a discriminated target without parsing it, so the caller can parse after this frame returns. */
function resolveDiscriminatedTarget(
  definition: DiscriminatedUnionDefinition,
  input: unknown,
  path: Path,
  useAliases: boolean,
  reportIssues: boolean
):
  | InternalParseResult<unknown>
  | {
      matched: true
      runtime: RuntimeStruct
      definition: ObjectDefinition
      cached: { inputKey: string; value: unknown }
    } {
  if (!isPlainObject(input)) {
    return reportIssues ? failure(issue([...path], "invalid_type", "object", input)) : QUIET_FAILURE
  }

  const discriminatorPath = [...path, definition.discriminator]
  if (!useAliases) {
    const value = hasOwnKey(input, definition.discriminator)
      ? input[definition.discriminator]
      : undefined
    if (value === undefined) {
      return reportIssues
        ? failure(issue(discriminatorPath, "missing_key", definition.expected, undefined))
        : QUIET_FAILURE
    }
    const target = definition.map.get(value)
    if (!target) {
      return reportIssues
        ? failure(issue(discriminatorPath, "invalid_union", definition.expected, value))
        : QUIET_FAILURE
    }
    const runtime = target as RuntimeStruct
    return {
      matched: true,
      runtime,
      definition: runtime[DEFINITION] as ObjectDefinition,
      cached: { inputKey: definition.discriminator, value }
    }
  }

  for (const wireKey of definition.discriminatorWireKeys ?? []) {
    if (!hasOwnKey(input, wireKey)) {
      continue
    }

    const value = input[wireKey]
    if (value === undefined) {
      return reportIssues
        ? failure(issue(discriminatorPath, "missing_key", definition.expected, undefined))
        : QUIET_FAILURE
    }
    const target = definition.map.get(value) as RuntimeStruct | undefined
    if (!target || definition.wireKeyByValue?.get(value) !== wireKey) {
      return reportIssues
        ? failure(issue(discriminatorPath, "invalid_union", definition.expected, value))
        : QUIET_FAILURE
    }
    return {
      matched: true,
      runtime: target,
      definition: target[DEFINITION] as ObjectDefinition,
      cached: { inputKey: wireKey, value }
    }
  }
  return reportIssues
    ? failure(issue(discriminatorPath, "missing_key", definition.expected, undefined))
    : QUIET_FAILURE
}
