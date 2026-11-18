import type { EnqueueOptions, JobBackoff, JobHandlers, JobWorkerOptions } from "./types"
import type { ResolvedEnqueueOptions, ResolvedJobWorkerOptions } from "./provider-types"

const maximumTimerMs = 2_147_483_647
const defaultDrainTimeoutMs = 25_000
const maximumNameBytes = 256
const encoder = new TextEncoder()

/** Validates a code-defined job or queue name. */
export function jobName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new TypeError("job name must be a non-empty well-formed string")
  }
  if (encoder.encode(value).byteLength > maximumNameBytes) {
    throw new TypeError("job name must be at most 256 UTF-8 bytes")
  }
  return value
}

/** Validates a queue name with the same bounds as a job name. */
export function queueName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new TypeError("job queue name must be a non-empty well-formed string")
  }
  if (encoder.encode(value).byteLength > maximumNameBytes) {
    throw new TypeError("job queue name must be at most 256 UTF-8 bytes")
  }
  return value
}

/** Round-trips a payload through JSON. `Date` values arrive as strings. */
export function jsonPayload<T>(payload: T): T {
  let text: string | undefined
  try {
    text = JSON.stringify(payload)
  } catch (error) {
    throw new TypeError("job payload must be JSON serializable", { cause: error })
  }
  if (typeof text !== "string") throw new TypeError("job payload must be JSON serializable")
  return JSON.parse(text) as T
}

/** Parses a drain bound. The default is 25 seconds. */
export function drainTimeout(value: number | undefined): number {
  const selected = value ?? defaultDrainTimeoutMs
  if (!Number.isInteger(selected) || selected < 0 || selected > maximumTimerMs) {
    throw new RangeError("drainTimeoutMs must be an integer from 0 to 2147483647")
  }
  return selected
}

/** Parses one positive safe integer, applying `fallback` when the option is omitted. */
export function positiveCount(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return selected
}

/** Parses backoff. The default is a fixed delay of zero. */
export function backoffOf(value: JobBackoff | undefined): JobBackoff {
  const selected = value ?? { type: "fixed", delayMs: 0 }
  if (typeof selected !== "object" || selected === null) {
    throw new TypeError("job backoff must be an object")
  }
  if (selected.type !== "fixed" && selected.type !== "exponential") {
    throw new TypeError("job backoff type must be fixed or exponential")
  }
  if (
    !Number.isInteger(selected.delayMs) ||
    selected.delayMs < 0 ||
    selected.delayMs > maximumTimerMs
  ) {
    throw new RangeError("job backoff delayMs must be an integer from 0 to 2147483647")
  }
  return Object.freeze({ type: selected.type, delayMs: selected.delayMs })
}

/** Validates enqueue options and fills defaults. */
export function resolveEnqueueOptions(options?: EnqueueOptions): ResolvedEnqueueOptions {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("job enqueue options must be an object")
  }
  let id: string | null = null
  if (options?.id !== undefined) {
    if (typeof options.id !== "string" || options.id.length === 0 || !options.id.isWellFormed()) {
      throw new TypeError("job id must be a non-empty well-formed string")
    }
    id = options.id
  }
  return Object.freeze({
    id,
    attempts: positiveCount(options?.attempts, 1, "job attempts"),
    backoff: backoffOf(options?.backoff)
  })
}

/** Validates worker options and fills defaults. */
export function resolveWorkerOptions(options?: JobWorkerOptions): ResolvedJobWorkerOptions {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("job worker options must be an object")
  }
  return Object.freeze({
    concurrency: positiveCount(options?.concurrency, 1, "job concurrency"),
    drainTimeoutMs: drainTimeout(options?.drainTimeoutMs)
  })
}

/** Copies own handler entries. Inherited names, including `__proto__`, are ignored. */
export function snapshotHandlers<T>(handlers: JobHandlers<T>): JobHandlers<T> {
  if (typeof handlers !== "object" || handlers === null) {
    throw new TypeError("job handlers must be an object")
  }
  const names = Object.keys(handlers)
  if (names.length === 0) throw new TypeError("job handlers must contain at least one entry")
  const snapshot: Record<string, JobHandlers<T>[string]> = Object.create(null) as Record<
    string,
    JobHandlers<T>[string]
  >
  for (const name of names) {
    jobName(name)
    const handler = handlers[name]
    if (typeof handler !== "function") throw new TypeError("job handler must be a function")
    Object.defineProperty(snapshot, name, {
      configurable: false,
      enumerable: true,
      value: handler,
      writable: false
    })
  }
  return Object.freeze(snapshot)
}

/** Delay before attempt `attempt` (1-based, attempt >= 2). */
export function retryDelay(backoff: JobBackoff, attempt: number): number {
  if (backoff.type === "fixed" || backoff.delayMs === 0) return backoff.delayMs
  const shift = attempt - 2
  if (shift <= 0) return backoff.delayMs
  if (shift >= 31) return maximumTimerMs
  const scaled = backoff.delayMs * 2 ** shift
  if (!Number.isFinite(scaled) || scaled >= maximumTimerMs) return maximumTimerMs
  return Math.floor(scaled)
}
