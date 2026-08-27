import {
  codec,
  logger,
  secure,
  timeout,
  tlsConfig,
  type DialOption,
  type DialOptions,
  type ListenOption,
  type ListenOptions,
  type Option,
  type Options
} from "@go-like/transport"

export const defaultDialTimeoutMs = 5_000

/** Returns the reviewed provider-neutral common defaults. */
export function defaultMemoryOptions(): Options {
  return Object.freeze({
    codec: null,
    logger: null,
    timeoutMs: 0,
    secure: false,
    tlsConfig: null
  })
}

/** Rebuilds one common option state through the public validators and defensive wrappers. */
export function snapshotMemoryOptions(value: Options): Options {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("memory transport options must be an object")
  }
  let snapshot = defaultMemoryOptions()
  const reducers: readonly Option[] = [
    codec(value.codec),
    logger(value.logger),
    timeout(value.timeoutMs),
    secure(value.secure),
    tlsConfig(value.tlsConfig)
  ]
  for (const reducer of reducers) snapshot = reducer(snapshot)
  return snapshot
}

/** Applies common options in declaration order for resources created afterwards. */
export function applyMemoryOptions(current: Options, options: readonly Option[]): Options {
  let value = current
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("transport option must be a function")
    value = snapshotMemoryOptions(option(value))
  }
  return value
}

/** Applies and validates provider-neutral dial options. */
export function applyMemoryDialOptions(options: readonly DialOption[]): DialOptions {
  let value: DialOptions = Object.freeze({
    timeoutMs: defaultDialTimeoutMs,
    connectionClose: false
  })
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("dial option must be a function")
    const reduced = option(value)
    if (typeof reduced !== "object" || reduced === null) {
      throw new TypeError("dial options must be an object")
    }
    if (!Number.isSafeInteger(reduced.timeoutMs) || reduced.timeoutMs < 0) {
      throw new RangeError("dial timeoutMs must be a finite non-negative integer")
    }
    if (typeof reduced.connectionClose !== "boolean")
      throw new TypeError("dial connectionClose must be a boolean")
    value = Object.freeze({
      timeoutMs: reduced.timeoutMs,
      connectionClose: reduced.connectionClose
    })
  }
  return value
}

/** Executes generic listen reducers even though memory currently defines no provider fields. */
export function applyMemoryListenOptions(options: readonly ListenOption[]): ListenOptions {
  let value: ListenOptions = Object.freeze({})
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("listen option must be a function")
    const reduced = option(value)
    if (typeof reduced !== "object" || reduced === null || Array.isArray(reduced)) {
      throw new TypeError("listen options must be an object")
    }
    value = Object.freeze(reduced)
  }
  return value
}

/** Chooses the earliest non-zero operation timeout captured by a Client. */
export function effectiveTimeout(commonTimeoutMs: number, dialTimeoutMs: number): number {
  if (commonTimeoutMs === 0) return dialTimeoutMs
  if (dialTimeoutMs === 0) return commonTimeoutMs
  return Math.min(commonTimeoutMs, dialTimeoutMs)
}
