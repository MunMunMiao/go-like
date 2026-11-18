import { resolveObjectShape } from "./shape"
import { DEFINITION } from "./symbols"
import type { ObjectDefinition, RuntimeStruct, StructDefinition, StructLike } from "./types"
import { hasOwnKey, isPlainObject, matchesEnum } from "./utils"
import { enterEncode } from "./value-graph"

/** Returns whether a runtime struct accepts a value, without producing issues. */
export function matchesRuntimeValue(struct: RuntimeStruct, value: unknown): boolean {
  return matchesDefinition(struct[DEFINITION], value, struct)
}

/** Returns every union branch that accepts `value`, in declaration order. */
export function selectUnionOptions(
  options: readonly StructLike<unknown, unknown, boolean>[],
  value: unknown
): RuntimeStruct[] {
  const matches: RuntimeStruct[] = []
  for (const option of options) {
    const runtime = option as unknown as RuntimeStruct
    if (matchesRuntimeValue(runtime, value)) {
      matches.push(runtime)
    }
  }
  return matches
}

/** Returns the first union branch that accepts `value`. */
export function selectUnionOption(
  options: readonly StructLike<unknown, unknown, boolean>[],
  value: unknown
): RuntimeStruct | undefined {
  return selectUnionOptions(options, value)[0]
}

/** Returns whether `definition` accepts `value`. Object shape still comes from `struct`. */
export function matchesDefinition(
  definition: StructDefinition,
  value: unknown,
  struct: RuntimeStruct
): boolean {
  return runMatch(struct, definition, value, false)
}

type MatchMode = "check" | "every" | "object" | "some"

interface MatchChild {
  enter: boolean
  struct: RuntimeStruct
  value: unknown
}

interface MatchFrame {
  answer: boolean
  definition: StructDefinition
  enter: boolean
  finished: boolean
  index: number
  item: RuntimeStruct | undefined
  keys: readonly string[] | undefined
  leave: (() => void) | undefined
  list: readonly unknown[] | undefined
  mode: MatchMode
  object: { [key: string]: unknown } | undefined
  opened: boolean
  options: readonly RuntimeStruct[] | undefined
  record: { [key: string]: unknown } | undefined
  shape: { [key: string]: unknown } | undefined
  struct: RuntimeStruct
  total: number
  tuple: readonly StructLike<unknown, unknown, boolean>[] | undefined
  value: unknown
  waiting: boolean
}

// One heap walk, so nested or() and objects do not grow the JavaScript stack.
function runMatch(
  struct: RuntimeStruct,
  definition: StructDefinition,
  value: unknown,
  enter: boolean
): boolean {
  const frames: MatchFrame[] = [matchFrame(struct, definition, value, enter)]
  let answer = false
  try {
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as MatchFrame
      if (frame.waiting) {
        frame.waiting = false
        acceptMatch(frame, answer)
      }
      if (frame.finished) {
        answer = frame.answer
        popMatch(frames)
        continue
      }
      if (!frame.opened) {
        openMatch(frame)
        if (frame.finished) {
          answer = frame.answer
          popMatch(frames)
          continue
        }
      }
      const child = nextMatchChild(frame)
      if (child === undefined) {
        if (!frame.finished) frame.answer = frame.mode !== "some"
        answer = frame.answer
        popMatch(frames)
        continue
      }
      frame.waiting = true
      frames.push(matchFrame(child.struct, child.struct[DEFINITION], child.value, child.enter))
    }
    return answer
  } finally {
    while (frames.length > 0) popMatch(frames)
  }
}

function matchFrame(
  struct: RuntimeStruct,
  definition: StructDefinition,
  value: unknown,
  enter: boolean
): MatchFrame {
  return {
    answer: false,
    definition,
    enter,
    finished: false,
    index: 0,
    item: undefined,
    keys: undefined,
    leave: undefined,
    list: undefined,
    mode: "check",
    object: undefined,
    opened: false,
    options: undefined,
    record: undefined,
    shape: undefined,
    struct,
    total: 0,
    tuple: undefined,
    value,
    waiting: false
  }
}

function popMatch(frames: MatchFrame[]): void {
  const frame = frames.pop() as MatchFrame
  const leave = frame.leave
  frame.leave = undefined
  if (leave !== undefined) leave()
}

function acceptMatch(frame: MatchFrame, ok: boolean): void {
  if (frame.mode === "some") {
    if (ok) {
      frame.answer = true
      frame.finished = true
      return
    }
  } else if (!ok) {
    frame.answer = false
    frame.finished = true
    return
  }
  frame.index += 1
}

function openMatch(frame: MatchFrame): void {
  if (frame.enter && frame.leave === undefined) frame.leave = enterEncode(frame.value)
  frame.opened = true
  const value = frame.value
  if (value === null) {
    if (frame.definition.kind === "null" || frame.definition.flags.nullable) {
      frame.answer = true
      frame.finished = true
      return
    }
    if (
      (frame.definition.kind !== "literal" || frame.definition.value !== null) &&
      frame.definition.kind !== "intersection" &&
      frame.definition.kind !== "or"
    ) {
      frame.answer = false
      frame.finished = true
      return
    }
  }
  if (typeof value === "undefined") {
    frame.answer = frame.definition.flags.optional
    frame.finished = true
    return
  }

  while (frame.definition.kind === "discriminatedUnion") {
    if (!isPlainObject(value) || !hasOwnKey(value, frame.definition.discriminator)) {
      frame.answer = false
      frame.finished = true
      return
    }
    const target = frame.definition.map.get(value[frame.definition.discriminator]) as
      | RuntimeStruct
      | undefined
    if (target === undefined) {
      frame.answer = false
      frame.finished = true
      return
    }
    frame.struct = target
    frame.definition = target[DEFINITION]
  }

  const definition = frame.definition
  switch (definition.kind) {
    case "any":
    case "unknown":
      frame.answer = true
      frame.finished = true
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
      frame.answer = (definition.runtimeIs ?? definition.is)(value)
      frame.finished = true
      return
    case "literal":
      frame.answer = Object.is(value, definition.value)
      frame.finished = true
      return
    case "enum":
      frame.answer = matchesEnum(definition, value)
      frame.finished = true
      return
    case "array":
      if (!Array.isArray(value)) {
        frame.answer = false
        frame.finished = true
        return
      }
      frame.mode = "every"
      frame.list = value
      frame.item = definition.item as unknown as RuntimeStruct
      frame.total = value.length
      return
    case "tuple":
      if (!Array.isArray(value) || value.length !== definition.items.length) {
        frame.answer = false
        frame.finished = true
        return
      }
      frame.mode = "every"
      frame.list = value
      frame.tuple = definition.items
      frame.total = value.length
      return
    case "object": {
      if (!isPlainObject(value)) {
        frame.answer = false
        frame.finished = true
        return
      }
      const shape = resolveObjectShape(frame.struct, frame.struct[DEFINITION] as ObjectDefinition)
      const keys: string[] = []
      for (const key in shape) keys.push(key)
      frame.mode = "object"
      frame.shape = shape
      frame.keys = keys
      frame.object = value
      frame.total = keys.length
      return
    }
    case "record":
      if (!isPlainObject(value)) {
        frame.answer = false
        frame.finished = true
        return
      }
      frame.mode = "every"
      frame.record = value
      frame.keys = Object.keys(value)
      frame.item = definition.value as unknown as RuntimeStruct
      frame.total = frame.keys.length
      return
    case "or":
      frame.mode = "some"
      frame.options = definition.options as unknown as readonly RuntimeStruct[]
      frame.total = definition.options.length
      return
    case "intersection":
      frame.mode = "every"
      frame.options = definition.options as unknown as readonly RuntimeStruct[]
      frame.total = definition.options.length
      return
  }
}

function nextMatchChild(frame: MatchFrame): MatchChild | undefined {
  while (frame.index < frame.total) {
    if (frame.mode === "object") {
      const key = (frame.keys as readonly string[])[frame.index] as string
      const field = (frame.shape as { [key: string]: unknown })[key] as RuntimeStruct
      const object = frame.object as { [key: string]: unknown }
      if (!hasOwnKey(object, key)) {
        if (!field[DEFINITION].flags.optional) {
          frame.answer = false
          frame.finished = true
          return undefined
        }
        frame.index += 1
        continue
      }
      return { enter: true, struct: field, value: object[key] }
    }
    if (frame.options !== undefined) {
      return {
        enter: false,
        struct: frame.options[frame.index] as RuntimeStruct,
        value: frame.value
      }
    }
    if (frame.record !== undefined) {
      const key = (frame.keys as readonly string[])[frame.index] as string
      return { enter: true, struct: frame.item as RuntimeStruct, value: frame.record[key] }
    }
    if (frame.list !== undefined) {
      let index = frame.index
      while (index < frame.list.length && !Object.hasOwn(frame.list, index)) index += 1
      frame.index = index
      if (frame.index < frame.total) {
        const item =
          frame.tuple !== undefined
            ? (frame.tuple[frame.index] as unknown as RuntimeStruct)
            : (frame.item as RuntimeStruct)
        return { enter: true, struct: item, value: frame.list[frame.index] }
      }
    }
    break
  }
  return undefined
}
