import { issue, StructError } from "./errors"
import { isPlainObject } from "./utils"

/** Maximum nested container count that is safe across supported JavaScript runtimes. */
export const PORTABLE_VALUE_GRAPH_DEPTH_LIMIT = 1000

interface EnterFrame {
  readonly containerDepth: number
  readonly entering: true
  readonly value: unknown
}

interface LeaveFrame {
  readonly entering: false
  readonly value: object
}

type ValueGraphFrame = EnterFrame | LeaveFrame

/** Returns a stable error message when an external value graph is unsafe to recurse through. */
export function portableValueGraphError(value: unknown): string | undefined {
  const active = new WeakSet<object>()
  const stack: ValueGraphFrame[] = [{ containerDepth: 0, entering: true, value }]

  while (stack.length > 0) {
    const frame = stack.pop() as ValueGraphFrame
    if (!frame.entering) {
      active.delete(frame.value)
      continue
    }

    const container = valueContainer(frame.value)
    if (!container) {
      continue
    }

    const containerDepth = frame.containerDepth + 1
    if (containerDepth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) {
      return `struct value exceeds portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
    }
    if (active.has(container)) {
      return "struct value contains a cycle"
    }

    active.add(container)
    stack.push({ entering: false, value: container })

    const keys = Object.keys(container)
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string
      const descriptor = Object.getOwnPropertyDescriptor(container, key)
      if (descriptor && Object.hasOwn(descriptor, "value")) {
        stack.push({ containerDepth, entering: true, value: descriptor.value })
      }
    }
  }

  return undefined
}

/** Rejects an unsafe external value graph before recursive encoding begins. */
export function assertPortableValueGraph(value: unknown): void {
  const message = portableValueGraphError(value)
  if (message) {
    throw new TypeError(message)
  }
}

function valueContainer(value: unknown): { [key: string]: unknown } | undefined {
  if (Array.isArray(value)) {
    return value as unknown as { [key: string]: unknown }
  }
  return isPlainObject(value) ? value : undefined
}

interface EncodeGraph {
  active: WeakSet<object>
  depth: number
}

const encodeGraphs: EncodeGraph[] = []

function encodeContainer(value: unknown): object | undefined {
  if (Array.isArray(value) || isPlainObject(value)) return value
  return undefined
}

function encodeGraphError(value: unknown, message: string): StructError {
  return new StructError([issue([], "custom", "safe struct value graph", value, message)])
}

/** Tracks one public encode. Recursion inside that call shares its graph. */
export function withEncodeGraph<T>(value: unknown, run: () => T): T {
  const graph: EncodeGraph = { active: new WeakSet(), depth: 0 }
  const container = encodeContainer(value)
  if (container !== undefined) {
    graph.depth = 1
    graph.active.add(container)
  }
  encodeGraphs.push(graph)
  try {
    return run()
  } finally {
    encodeGraphs.pop()
  }
}

function noopLeave(): void {}

/** Enters one child container before a recursive encode, and returns the matching leave. */
export function enterEncode(value: unknown): () => void {
  const graph = encodeGraphs[encodeGraphs.length - 1]
  const container = encodeContainer(value)
  if (graph === undefined || container === undefined) return noopLeave
  const depth = graph.depth + 1
  if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) {
    throw encodeGraphError(
      value,
      `struct value exceeds portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
    )
  }
  if (graph.active.has(container)) {
    throw encodeGraphError(value, "struct value contains a cycle")
  }
  graph.depth = depth
  graph.active.add(container)
  return function leaveEncode(): void {
    graph.active.delete(container)
    graph.depth -= 1
  }
}

/** Merges plain objects and equal-length arrays. Unequal arrays throw; other values replace. */
export function mergePlainObjects(existing: unknown, incoming: unknown, depth = 1): unknown {
  if (existing === incoming) return incoming
  if (Array.isArray(existing) || Array.isArray(incoming)) {
    if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming
    if (existing.length !== incoming.length) {
      throw encodeGraphError(incoming, "struct intersection arrays have different lengths")
    }
    if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) {
      throw encodeGraphError(
        incoming,
        `struct value exceeds portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
      )
    }
    const output: unknown[] = []
    for (let index = 0; index < existing.length; index += 1) {
      output.push(mergePlainObjects(existing[index], incoming[index], depth + 1))
    }
    return output
  }
  if (!isPlainObject(existing) || !isPlainObject(incoming)) return incoming
  if (depth > PORTABLE_VALUE_GRAPH_DEPTH_LIMIT) {
    throw encodeGraphError(
      incoming,
      `struct value exceeds portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
    )
  }
  const output: { [key: string]: unknown } = Object.create(null)
  for (const key of Object.keys(existing)) output[key] = existing[key]
  for (const key of Object.keys(incoming)) {
    output[key] = Object.hasOwn(output, key)
      ? mergePlainObjects(output[key], incoming[key], depth + 1)
      : incoming[key]
  }
  return output
}

/** Folds intersection side results through one deep merge. Identical passthrough sides can be skipped. */
export function foldIntersectionResults(
  sides: readonly unknown[],
  source: unknown,
  skipPassthrough: boolean
): unknown {
  let accumulated: unknown
  let started = false
  let last = source
  for (const side of sides) {
    last = side
    if (skipPassthrough && side === source) continue
    if (!started) {
      accumulated = side
      started = true
      continue
    }
    accumulated = mergePlainObjects(accumulated, side)
  }
  return started ? accumulated : last
}
