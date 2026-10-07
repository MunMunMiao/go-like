import { mapAliasedObjectFields, resolveStructFields } from "./fields"
import type { ResolvedStructField } from "./fields"
import { matchesRuntimeValue, selectUnionOptions } from "./match"
import { resolveObjectShape } from "./shape"
import { DEFINITION } from "./symbols"
import type {
  ArrayDefinition,
  IntersectionDefinition,
  RecordDefinition,
  RuntimeStruct,
  TupleDefinition,
  UnionDefinition
} from "./types"
import { hasOwnKey, isPlainObject } from "./utils"
import {
  assertPortableValueGraph,
  enterEncode,
  foldIntersectionResults,
  mergePlainObjects
} from "./value-graph"

export { matchesDefinition } from "./match"

export interface EncodeOptions {
  encodeObject?: (
    struct: RuntimeStruct,
    value: { [key: string]: unknown },
    encodeChild: (struct: RuntimeStruct, value: unknown) => unknown
  ) => unknown
  selectUnionOptions?: typeof selectUnionOptions
}

function sameEncodedShape(
  leftStruct: RuntimeStruct,
  leftValue: unknown,
  rightStruct: RuntimeStruct,
  rightValue: unknown,
  options: EncodeOptions
): boolean {
  return sameWireValue(
    getComparableEncodedValue(leftStruct, leftValue, options),
    getComparableEncodedValue(rightStruct, rightValue, options)
  )
}

function sameWireValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameWireValue(item, right[index]))
    )
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => hasOwnKey(right, key) && sameWireValue(left[key], right[key]))
  )
}

function getComparableEncodedValue(
  struct: RuntimeStruct,
  value: unknown,
  options: EncodeOptions
): unknown {
  const definition = struct[DEFINITION]
  if (
    options.encodeObject &&
    definition.alias &&
    (definition.kind === "array" || definition.kind === "object")
  ) {
    return { alias: definition.alias, value }
  }
  return value
}

type EncodePhase = "ambiguous" | "array" | "intersection" | "object" | "record" | "tuple" | "value"

interface EncodeFrame {
  aliased: boolean
  done: boolean
  enter: boolean
  fields: readonly ResolvedStructField[] | undefined
  first: unknown
  index: number
  key: string
  keys: readonly string[] | undefined
  leave: (() => void) | undefined
  list: readonly unknown[] | undefined
  matches: readonly RuntimeStruct[] | undefined
  objectSides: boolean
  opened: boolean
  output: unknown
  phase: EncodePhase
  record: { [key: string]: unknown } | undefined
  shape: { [key: string]: unknown } | undefined
  sides: unknown[] | undefined
  slot: number
  struct: RuntimeStruct
  value: unknown
  waiting: boolean
}

// One heap walk. Nested containers stay off the JavaScript stack, and the caller
// has already entered this root value.
function encodeFrame(struct: RuntimeStruct, value: unknown, enter: boolean): EncodeFrame {
  return {
    aliased: false,
    done: false,
    enter,
    fields: undefined,
    first: undefined,
    index: 0,
    key: "",
    keys: undefined,
    leave: undefined,
    list: undefined,
    matches: undefined,
    objectSides: false,
    opened: false,
    output: undefined,
    phase: "value",
    record: undefined,
    shape: undefined,
    sides: undefined,
    slot: 0,
    struct,
    value,
    waiting: false
  }
}

function holeyArray(length: number): unknown[] {
  const output: unknown[] = []
  output.length = length
  return output
}

function finishEncode(frame: EncodeFrame, output: unknown): void {
  frame.output = output
  frame.done = true
}

function popEncode(frames: EncodeFrame[]): void {
  const frame = frames.pop() as EncodeFrame
  const leave = frame.leave
  frame.leave = undefined
  if (leave !== undefined) leave()
}

// Union and discriminated tails reuse this frame, so the value is not entered twice.
function adoptEncode(frame: EncodeFrame, next: RuntimeStruct): void {
  frame.struct = next
  frame.opened = false
  frame.enter = false
  frame.phase = "value"
  frame.done = false
  frame.waiting = false
  frame.index = 0
}

function encodeSuppliedChild(
  options: EncodeOptions
): (struct: RuntimeStruct, value: unknown) => unknown {
  return function encodeChild(fieldStruct: RuntimeStruct, fieldValue: unknown): unknown {
    const leave = enterEncode(fieldValue)
    try {
      return encodeValue(fieldStruct, fieldValue, options)
    } finally {
      leave()
    }
  }
}

function chooseUnion(
  frame: EncodeFrame,
  definition: UnionDefinition,
  value: unknown,
  options: EncodeOptions
): void {
  if (!options.encodeObject && !options.selectUnionOptions && definition.uniformIdentityEncode) {
    for (const option of definition.options) {
      const runtime = option as RuntimeStruct
      if (matchesRuntimeValue(runtime, value)) {
        adoptEncode(frame, runtime)
        return
      }
    }
    finishEncode(frame, value)
    return
  }

  const selectOptions = options.selectUnionOptions ?? selectUnionOptions
  const matches = selectOptions(definition.options, value)
  // Identical branch objects encode the same wire value. Re-encoding them is exponential.
  const unique: RuntimeStruct[] = []
  for (const match of matches) {
    if (!unique.includes(match)) unique.push(match)
  }
  const first = unique[0]
  if (first === undefined) {
    finishEncode(frame, value)
    return
  }
  if (unique.length === 1) {
    adoptEncode(frame, first)
    return
  }
  frame.phase = "ambiguous"
  frame.matches = unique
  frame.index = 0
}

function openEncode(frame: EncodeFrame, options: EncodeOptions): void {
  if (frame.enter && frame.leave === undefined) frame.leave = enterEncode(frame.value)
  frame.opened = true
  const value = frame.value
  const definition = frame.struct[DEFINITION]
  if (value === null && (definition.kind === "null" || definition.flags.nullable)) {
    finishEncode(frame, null)
    return
  }
  if (typeof value === "undefined" && definition.flags.optional) {
    finishEncode(frame, undefined)
    return
  }

  switch (definition.kind) {
    case "any":
    case "unknown":
      assertPortableValueGraph(value)
      finishEncode(frame, value)
      return
    case "null":
    case "enum":
    case "literal":
      finishEncode(frame, value)
      return
    case "arrayBuffer":
    case "bigint":
    case "blob":
    case "boolean":
    case "date":
    case "file":
    case "number":
    case "string":
      finishEncode(frame, definition.encode ? definition.encode(value as never) : value)
      return
    case "array":
      if (!Array.isArray(value)) {
        finishEncode(frame, value)
        return
      }
      frame.phase = "array"
      frame.list = value
      frame.output = holeyArray(value.length)
      frame.index = 0
      return
    case "tuple":
      if (!Array.isArray(value)) {
        finishEncode(frame, value)
        return
      }
      frame.phase = "tuple"
      frame.list = value
      frame.output = holeyArray(value.length)
      frame.index = 0
      return
    case "record":
      if (!isPlainObject(value)) {
        finishEncode(frame, value)
        return
      }
      frame.phase = "record"
      frame.record = value
      frame.keys = Object.keys(value)
      frame.output = Object.create(null)
      frame.index = 0
      return
    case "object": {
      if (!isPlainObject(value)) {
        finishEncode(frame, value)
        return
      }
      if (options.encodeObject !== undefined && options.encodeObject !== mapAliasedObjectFields) {
        finishEncode(frame, options.encodeObject(frame.struct, value, encodeSuppliedChild(options)))
        return
      }
      frame.phase = "object"
      frame.output = Object.create(null)
      frame.index = 0
      frame.aliased = options.encodeObject === mapAliasedObjectFields
      if (frame.aliased) {
        frame.fields = resolveStructFields(frame.struct, definition)
        return
      }
      const shape = resolveObjectShape(frame.struct, definition)
      const keys: string[] = []
      for (const key in shape) keys.push(key)
      frame.shape = shape
      frame.keys = keys
      return
    }
    case "or":
      chooseUnion(frame, definition, value, options)
      return
    case "discriminatedUnion": {
      if (isPlainObject(value) && hasOwnKey(value, definition.discriminator)) {
        const matched = definition.map.get(value[definition.discriminator])
        if (matched) {
          adoptEncode(frame, matched as unknown as RuntimeStruct)
          return
        }
      }
      finishEncode(frame, value)
      return
    }
    case "intersection":
      beginIntersection(frame, definition, value)
      return
  }
}

function beginIntersection(
  frame: EncodeFrame,
  definition: IntersectionDefinition,
  value: unknown
): void {
  if (!definition.objectSides) {
    frame.phase = "intersection"
    frame.objectSides = false
    frame.sides = []
    frame.index = 0
    return
  }
  if (!isPlainObject(value)) {
    finishEncode(frame, value)
    return
  }
  frame.phase = "intersection"
  frame.objectSides = true
  frame.output = Object.create(null)
  frame.index = 0
}

function encodeObjectFields(frame: EncodeFrame, frames: EncodeFrame[]): void {
  const value = frame.value as { [key: string]: unknown }
  if (frame.aliased) {
    const fields = frame.fields as readonly ResolvedStructField[]
    while (frame.index < fields.length) {
      const field = fields[frame.index] as ResolvedStructField
      if (!hasOwnKey(value, field.key)) {
        frame.index += 1
        continue
      }
      const fieldValue = value[field.key]
      if (typeof fieldValue === "undefined") {
        frame.index += 1
        continue
      }
      frame.slot = frame.index
      frame.key = field.wireKey
      frame.waiting = true
      frames.push(encodeFrame(field.struct, fieldValue, true))
      return
    }
    frame.done = true
    return
  }

  const keys = frame.keys as readonly string[]
  const shape = frame.shape as { [key: string]: unknown }
  while (frame.index < keys.length) {
    const key = keys[frame.index] as string
    if (!hasOwnKey(value, key)) {
      frame.index += 1
      continue
    }
    frame.slot = frame.index
    frame.key = key
    frame.waiting = true
    frames.push(encodeFrame(shape[key] as RuntimeStruct, value[key], true))
    return
  }
  frame.done = true
}

function presentIndex(frame: EncodeFrame): number | undefined {
  const list = frame.list as readonly unknown[]
  let index = frame.index
  while (index < list.length && !Object.hasOwn(list, index)) index += 1
  frame.index = index
  if (index >= list.length) return undefined
  return index
}

function stepArray(frame: EncodeFrame, frames: EncodeFrame[]): void {
  const index = presentIndex(frame)
  if (index === undefined) {
    frame.done = true
    return
  }
  const definition = frame.struct[DEFINITION] as ArrayDefinition
  frame.slot = index
  frame.waiting = true
  frames.push(
    encodeFrame(definition.item as RuntimeStruct, (frame.list as readonly unknown[])[index], true)
  )
}

function stepTuple(frame: EncodeFrame, frames: EncodeFrame[]): void {
  const index = presentIndex(frame)
  if (index === undefined) {
    frame.done = true
    return
  }
  const definition = frame.struct[DEFINITION] as TupleDefinition
  const list = frame.list as readonly unknown[]
  if (index >= definition.items.length) {
    ;(frame.output as unknown[])[index] = list[index]
    frame.index = index + 1
    return
  }
  frame.slot = index
  frame.waiting = true
  frames.push(encodeFrame(definition.items[index] as RuntimeStruct, list[index], true))
}

function stepRecord(frame: EncodeFrame, frames: EncodeFrame[]): void {
  const keys = frame.keys as readonly string[]
  if (frame.index >= keys.length) {
    frame.done = true
    return
  }
  const key = keys[frame.index] as string
  const definition = frame.struct[DEFINITION] as RecordDefinition
  frame.slot = frame.index
  frame.key = key
  frame.waiting = true
  frames.push(
    encodeFrame(
      definition.value as RuntimeStruct,
      (frame.record as { [key: string]: unknown })[key],
      true
    )
  )
}

function stepAmbiguous(frame: EncodeFrame, frames: EncodeFrame[]): void {
  const matches = frame.matches as readonly RuntimeStruct[]
  if (frame.index >= matches.length) {
    finishEncode(frame, frame.first)
    return
  }
  frame.waiting = true
  frames.push(encodeFrame(matches[frame.index] as RuntimeStruct, frame.value, false))
}

function encodeMixedIntersection(frame: EncodeFrame, frames: EncodeFrame[]): void {
  const definition = frame.struct[DEFINITION] as IntersectionDefinition
  if (frame.index >= definition.options.length) {
    finishEncode(frame, foldIntersectionResults(frame.sides ?? [], frame.value, true))
    return
  }
  frame.waiting = true
  frames.push(encodeFrame(definition.options[frame.index] as RuntimeStruct, frame.value, false))
}

function encodeIntersection(frame: EncodeFrame, frames: EncodeFrame[]): void {
  if (!frame.objectSides) {
    encodeMixedIntersection(frame, frames)
    return
  }
  const definition = frame.struct[DEFINITION] as IntersectionDefinition
  if (frame.index >= definition.options.length) {
    frame.done = true
    return
  }
  frame.waiting = true
  frames.push(encodeFrame(definition.options[frame.index] as RuntimeStruct, frame.value, false))
}

function acceptEncode(frame: EncodeFrame, produced: unknown, options: EncodeOptions): void {
  if (frame.phase === "array" || frame.phase === "tuple") {
    ;(frame.output as unknown[])[frame.slot] = produced
    frame.index = frame.slot + 1
    return
  }
  if (frame.phase === "record") {
    ;(frame.output as { [key: string]: unknown })[frame.key] = produced
    frame.index = frame.slot + 1
    return
  }
  if (frame.phase === "object") {
    const output = frame.output as { [key: string]: unknown }
    output[frame.key] = mergePlainObjects(output[frame.key], produced)
    frame.index = frame.slot + 1
    return
  }
  if (frame.phase === "ambiguous") {
    const matches = frame.matches as readonly RuntimeStruct[]
    const current = matches[frame.index] as RuntimeStruct
    if (frame.index === 0) frame.first = produced
    else if (
      !sameEncodedShape(matches[0] as RuntimeStruct, frame.first, current, produced, options)
    ) {
      throw new TypeError(
        "ambiguous union encode: multiple union branches match with different wire output"
      )
    }
    frame.index += 1
    return
  }
  if (frame.objectSides) frame.output = mergePlainObjects(frame.output, produced)
  else frame.sides?.push(produced)
  frame.index += 1
}

function stepEncode(frame: EncodeFrame, frames: EncodeFrame[]): void {
  if (frame.phase === "array") stepArray(frame, frames)
  else if (frame.phase === "tuple") stepTuple(frame, frames)
  else if (frame.phase === "record") stepRecord(frame, frames)
  else if (frame.phase === "object") encodeObjectFields(frame, frames)
  else if (frame.phase === "ambiguous") stepAmbiguous(frame, frames)
  else encodeIntersection(frame, frames)
}

export function encodeValue(
  struct: RuntimeStruct,
  value: unknown,
  options: EncodeOptions = {}
): unknown {
  const frames: EncodeFrame[] = [encodeFrame(struct, value, false)]
  let produced: unknown
  try {
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as EncodeFrame
      if (frame.waiting) {
        frame.waiting = false
        acceptEncode(frame, produced, options)
      }
      if (!frame.opened) openEncode(frame, options)
      else stepEncode(frame, frames)
      if (frame.done) {
        produced = frame.output
        popEncode(frames)
      }
    }
    return produced
  } finally {
    while (frames.length > 0) popEncode(frames)
  }
}
