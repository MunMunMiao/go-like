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
      stack.push({ containerDepth, entering: true, value: container[key] })
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
