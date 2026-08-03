import {
  objectSource,
  type ConfigObject,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher,
  type ConfigValue
} from "@likego/config"
import { cause, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

/** Executes one standard Web Fetch request without a runtime-global dependency. */
export type ConsulFetch = (request: Request) => Promise<Response>

/** Decodes one complete Consul KV value into a configuration object. */
export type ConsulDecoder = (text: string, key: string) => ConfigObject

export type ConsulConsistency = "default" | "consistent" | "stale"

export interface ConsulSourceOptions {
  readonly fetch: ConsulFetch
  readonly address: string
  readonly key: string
  readonly name?: string
  readonly token?: string
  readonly datacenter?: string
  readonly namespace?: string
  readonly consistency?: ConsulConsistency
  readonly waitMs?: number
  readonly minimumQueryIntervalMs?: number
  /** Selects the first delay after a retryable transport or Consul availability failure. */
  readonly retryInitialMs?: number
  /** Caps exponential watcher retry delay while preserving last-good configuration. */
  readonly retryMaximumMs?: number
  /** Decodes complete KV text; defaults to strict JSON object decoding. */
  readonly decode?: ConsulDecoder
}

export interface ConsulHttpError extends Error {
  readonly name: "ConsulHttpError"
  readonly code: "LIKEGO_CONSUL_HTTP"
  readonly status: number
  readonly key: string
}

interface ConsulHttpDetails {
  readonly name: "ConsulHttpError"
  readonly code: "LIKEGO_CONSUL_HTTP"
  readonly status: number
  readonly key: string
}

interface Cursor {
  readonly text: string
  readonly value: bigint
}

interface QueryResult {
  readonly text: string
  readonly cursor: Cursor
}

/** Performs one captured raw KV query with an optional blocking cursor. */
type ConsulQuery = (signal: AbortSignal | null, index: string | null) => Promise<QueryResult>

const UnsafeKeys = new Set(["__proto__", "constructor", "prototype"])
const WatcherStopped = Object.freeze(new Error("Consul watcher has stopped"))
const TransportFailure = Object.freeze(new Error("Consul KV transport failed"))

/** Observes a best-effort body cancellation rejection without replacing HTTP status. */
function ignoreBodyCancellationFailure(_error: unknown): void {}

/** Observes a late body rejection after Request cancellation already won the operation. */
function ignoreLateBodyFailure(_error: unknown): void {}

/** Validates JSON.parse output against the complete ConfigValue domain. */
function isJsonConfigValue(value: unknown): value is ConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonConfigValue(entry)) return false
    }
    return true
  }
  if (typeof value !== "object") return false
  for (const key of Object.keys(value)) {
    if (
      UnsafeKeys.has(key) ||
      !isJsonConfigValue(Object.getOwnPropertyDescriptor(value, key)?.value)
    )
      return false
  }
  return true
}

/** Narrows validated JSON to an object root rather than its array alternative. */
function isJsonConfigObject(value: unknown): value is ConfigObject {
  return (
    value !== null && !Array.isArray(value) && typeof value === "object" && isJsonConfigValue(value)
  )
}

/** Decodes strict JSON whose root is a safe configuration object. */
export function jsonConsulDecoder(text: string, key: string): ConfigObject {
  const value: unknown = JSON.parse(text)
  if (!isJsonConfigObject(value)) {
    throw new TypeError(`Consul key "${key}" must contain a JSON object`)
  }
  return value
}

/** Creates a secret-safe structured HTTP boundary error. */
function newHttpError(status: number, key: string): ConsulHttpError {
  const details = {
    name: "ConsulHttpError",
    code: "LIKEGO_CONSUL_HTTP",
    status,
    key
  } satisfies ConsulHttpDetails
  return Object.freeze(
    Object.assign(new Error(`Consul KV request failed with HTTP ${status}`), details)
  )
}

/** Classifies only transport, missing-key, overload, timeout, and server failures as retryable. */
function retryableQueryFailure(value: unknown): boolean {
  if (value === TransportFailure) return true
  if (value === null || typeof value !== "object" || !("code" in value) || !("status" in value))
    return false
  if (value.code !== "LIKEGO_CONSUL_HTTP" || typeof value.status !== "number") return false
  return (
    value.status === 404 ||
    value.status === 408 ||
    value.status === 425 ||
    value.status === 429 ||
    value.status >= 500
  )
}

/** Returns the caller's exact Context cancellation cause when terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Parses and clamps a Consul index so the next blocking request cannot busy-loop at zero. */
function cursor(value: string | null): Cursor {
  if (value === null || !/^[0-9]+$/.test(value))
    throw new TypeError("Consul response requires a decimal X-Consul-Index")
  const parsed = BigInt(value)
  return parsed === 0n
    ? Object.freeze({ text: "1", value: 1n })
    : Object.freeze({ text: value, value: parsed })
}

/** Returns the official zero cursor used only after observing an index rollback. */
function resetCursor(): Cursor {
  return Object.freeze({ text: "0", value: 0n })
}

/** Waits for one rate-limit interval while remaining abortable by Context or watcher stop. */
function waitForInterval(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  /** Owns one timer and one abort listener until exactly one wins. */
  function executor(resolve: () => void, reject: (error: unknown) => void): void {
    /** Resolves the interval and detaches its abort listener. */
    function elapsed(): void {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    /** Rejects the interval with the owning cancellation reason. */
    function aborted(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(elapsed, timeoutMs)
    signal.addEventListener("abort", aborted, { once: true })
  }
  return new Promise<void>(executor)
}

/** Joins one response-body read while allowing the Request signal to bound non-cooperative Fetch. */
function waitForBody(signal: AbortSignal, pending: Promise<string>): Promise<string> {
  if (signal.aborted) {
    void pending.catch(ignoreLateBodyFailure)
    return Promise.reject(signal.reason)
  }
  /** Owns the signal observer until either response body or cancellation settles. */
  function executor(resolve: (text: string) => void, reject: (error: unknown) => void): void {
    /** Resolves the body branch and detaches its signal observer. */
    function fulfilled(text: string): void {
      signal.removeEventListener("abort", aborted)
      resolve(text)
    }
    /** Rejects the body branch and detaches its signal observer. */
    function rejected(error: unknown): void {
      signal.removeEventListener("abort", aborted)
      reject(error)
    }
    /** Rejects immediately with the exact Request cancellation reason. */
    function aborted(): void {
      reject(signal.reason)
    }
    signal.addEventListener("abort", aborted, { once: true })
    void pending.then(fulfilled, rejected)
  }
  return new Promise<string>(executor)
}

/** Reads one successful response body and classifies every body failure as transport failure. */
async function readSuccessfulBody(response: Response, signal: AbortSignal | null): Promise<string> {
  let pending: Promise<string>
  try {
    pending = Promise.resolve(response.text())
  } catch {
    throw TransportFailure
  }
  try {
    return signal === null ? await pending : await waitForBody(signal, pending)
  } catch {
    if (signal !== null && signal.aborted) throw signal.reason
    throw TransportFailure
  }
}

/** Starts a non-blocking body cancellation so its failure or latency cannot replace HTTP status. */
function discardErrorBody(response: Response): void {
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    return
  }
  if (body === null) return
  try {
    void Promise.resolve(body.cancel()).catch(ignoreBodyCancellationFailure)
  } catch {
    return
  }
}

/** Encodes an exact Consul KV key while rejecting URL-normalized dot path segments. */
function encodedKey(key: string): string {
  const parts = key.split("/")
  const encoded: string[] = []
  for (const part of parts) {
    if (part === "." || part === "..")
      throw new TypeError("Consul key cannot contain a dot path segment")
    encoded.push(encodeURIComponent(part))
  }
  return encoded.join("/")
}

/** Validates and captures the Consul HTTP origin without credentials, path, query, or fragment. */
function consulOrigin(address: string): URL {
  const origin = new URL(address)
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError("Consul address must use HTTP or HTTPS")
  }
  if (
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.pathname !== "" && origin.pathname !== "/") ||
    origin.href.includes("?") ||
    origin.href.includes("#")
  ) {
    throw new TypeError(
      "Consul address must be an origin without credentials, path, query, or fragment"
    )
  }
  return origin
}

/** Creates one source-owned blocking-query watcher with Context-aware stop. */
function createWatcher(
  query: ConsulQuery,
  revision: string | null,
  minimumQueryIntervalMs: number,
  retryInitialMs: number,
  retryMaximumMs: number
): ConfigSourceWatcher {
  let current = revision === null ? resetCursor() : cursor(revision)
  let active: Promise<void> | null = null
  let waiting = false
  let stopped = false
  let shutdown: Promise<void> | null = null
  const controller = new AbortController()

  /** Converts a successful next result into the neutral active-operation barrier. */
  function ignoreNextValue(): void {}

  /** Converts a failed next result into the neutral active-operation barrier. */
  function ignoreNextFailure(_error: unknown): void {}

  /** Waits for one interval and maps cancellation through the current Context and owner state. */
  function watcherInterval(ctx: Context, signal: AbortSignal, timeoutMs: number): Promise<void> {
    /** Rejects with the highest-authority failure visible after an interval interruption. */
    function rejectInterval(error: unknown): Promise<never> {
      const failure = contextFailure(ctx)
      return Promise.reject(failure ?? (stopped ? WatcherStopped : error))
    }
    return waitForInterval(signal, timeoutMs).catch(rejectInterval)
  }

  /** Runs blocking queries until the index truly changes, honoring reset and zero rules. */
  async function runNext(ctx: Context): Promise<void> {
    const initialFailure = contextFailure(ctx)
    if (initialFailure !== null) throw initialFailure
    const callerSignal = ctx.done()
    const signal =
      callerSignal === null ? controller.signal : AbortSignal.any([callerSignal, controller.signal])
    let retryDelayMs = retryInitialMs
    let recovering = false
    try {
      while (true) {
        const startedAt = Date.now()
        let result: QueryResult
        try {
          result = await query(signal, current.text)
          const operationFailure = contextFailure(ctx)
          if (operationFailure !== null) throw operationFailure
          if (stopped) throw WatcherStopped
        } catch (error) {
          const failure = contextFailure(ctx)
          if (failure !== null) throw failure
          if (stopped) throw WatcherStopped
          if (!retryableQueryFailure(error)) throw error
          recovering = true
          await watcherInterval(ctx, signal, retryDelayMs)
          retryDelayMs = Math.min(retryMaximumMs, retryDelayMs * 2)
          continue
        }
        retryDelayMs = retryInitialMs
        if (recovering) {
          current = result.cursor
          return
        }
        if (result.cursor.value < current.value) {
          current = resetCursor()
        } else if (result.cursor.value > current.value) {
          current = result.cursor
          return
        }
        const remaining = minimumQueryIntervalMs - (Date.now() - startedAt)
        if (remaining > 0) await watcherInterval(ctx, signal, remaining)
      }
    } finally {
      waiting = false
    }
  }

  return Object.freeze({
    /** Waits until Consul reports an index change rather than a mere long-poll timeout. */
    next(ctx: Context): Promise<void> {
      if (stopped) return Promise.reject(WatcherStopped)
      if (waiting) return Promise.reject(new Error("Consul watcher is already waiting"))
      waiting = true
      const operation = runNext(ctx)
      active = operation.then(ignoreNextValue, ignoreNextFailure)
      return operation
    },
    /** Aborts and drains the active blocking request. */
    stop(ctx: Context): Promise<void> {
      if (shutdown === null) {
        stopped = true
        controller.abort(WatcherStopped)
        shutdown = active ?? Promise.resolve()
      }
      return waitForContext(ctx, shutdown)
    }
  })
}

/**
 * Creates a Consul KV source using only standard Web Fetch and AbortSignal APIs.
 *
 * The exact key is loaded as one complete document. The optional resident watcher uses Consul
 * blocking queries, ignores unchanged timeout responses, clamps zero indexes, and resets a cursor
 * that moves backwards before delivering the next dirty notification.
 */
export function consulSource(options: ConsulSourceOptions): ConfigSource {
  if (options === null || typeof options !== "object")
    throw new TypeError("Consul options must be an object")
  const fetch = options.fetch
  const address = options.address
  const key = options.key
  const name = options.name ?? "consul"
  const token = options.token
  const datacenter = options.datacenter
  const namespace = options.namespace
  const consistency = options.consistency ?? "default"
  const waitMs = options.waitMs ?? 300_000
  const minimumQueryIntervalMs = options.minimumQueryIntervalMs ?? 1_000
  const retryInitialMs = options.retryInitialMs ?? 250
  const retryMaximumMs = options.retryMaximumMs ?? Math.max(30_000, retryInitialMs)
  const decode = options.decode ?? jsonConsulDecoder
  if (typeof fetch !== "function") throw new TypeError("Consul Fetch capability must be callable")
  if (typeof address !== "string") throw new TypeError("Consul address must be a string")
  const origin = consulOrigin(address)
  if (typeof key !== "string" || key.length === 0)
    throw new TypeError("Consul key must be non-empty")
  const keyPath = encodedKey(key)
  if (typeof name !== "string" || name.length === 0)
    throw new TypeError("Consul source name must be non-empty")
  if (token !== undefined && (typeof token !== "string" || token.length === 0)) {
    throw new TypeError("Consul token must be a non-empty string")
  }
  if (datacenter !== undefined && (typeof datacenter !== "string" || datacenter.length === 0)) {
    throw new TypeError("Consul datacenter must be a non-empty string")
  }
  if (namespace !== undefined && (typeof namespace !== "string" || namespace.length === 0)) {
    throw new TypeError("Consul namespace must be a non-empty string")
  }
  if (consistency !== "default" && consistency !== "consistent" && consistency !== "stale") {
    throw new TypeError("invalid Consul consistency mode")
  }
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 600_000) {
    throw new TypeError("Consul waitMs must be an integer from 1 through 600000")
  }
  if (
    !Number.isInteger(minimumQueryIntervalMs) ||
    minimumQueryIntervalMs < 1 ||
    minimumQueryIntervalMs > 60_000
  ) {
    throw new TypeError("Consul minimumQueryIntervalMs must be an integer from 1 through 60000")
  }
  if (!Number.isInteger(retryInitialMs) || retryInitialMs < 1 || retryInitialMs > 60_000) {
    throw new TypeError("Consul retryInitialMs must be an integer from 1 through 60000")
  }
  if (
    !Number.isInteger(retryMaximumMs) ||
    retryMaximumMs < retryInitialMs ||
    retryMaximumMs > 600_000
  ) {
    throw new TypeError(
      "Consul retryMaximumMs must be an integer from retryInitialMs through 600000"
    )
  }
  if (typeof decode !== "function") throw new TypeError("Consul decoder must be callable")

  /** Creates one exact KV URL with optional blocking query controls. */
  function queryUrl(index: string | null): URL {
    const url = new URL(`/v1/kv/${keyPath}`, origin)
    url.searchParams.set("raw", "true")
    if (datacenter !== undefined) url.searchParams.set("dc", datacenter)
    if (namespace !== undefined) url.searchParams.set("ns", namespace)
    if (consistency !== "default") url.searchParams.set(consistency, "")
    if (index !== null) {
      url.searchParams.set("index", index)
      url.searchParams.set("wait", `${waitMs}ms`)
    }
    return url
  }

  /** Performs one raw KV request with status-authoritative and abort-bounded body handling. */
  async function query(signal: AbortSignal | null, index: string | null): Promise<QueryResult> {
    const headers = new Headers({ Accept: "text/plain" })
    if (token !== undefined) headers.set("X-Consul-Token", token)
    const url = queryUrl(index)
    const request =
      signal === null
        ? new Request(url, { headers, redirect: "error" })
        : new Request(url, { headers, redirect: "error", signal })
    let response: Response
    try {
      response = await fetch(request)
    } catch {
      throw TransportFailure
    }
    if (!response.ok) {
      discardErrorBody(response)
      throw newHttpError(response.status, key)
    }
    const text = await readSuccessfulBody(response, signal)
    const responseCursor = cursor(response.headers.get("X-Consul-Index"))
    return Object.freeze({ text, cursor: responseCursor })
  }

  return Object.freeze({
    name,
    /** Loads, decodes, validates, and snapshots the exact current KV value. */
    async load(ctx: Context): Promise<ConfigSourceSnapshot> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      try {
        const result = await query(ctx.done(), null)
        const queryFailure = contextFailure(ctx)
        if (queryFailure !== null) throw queryFailure
        const decoded = decode(result.text, key)
        const stable = await objectSource(name, decoded).load(ctx)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return Object.freeze({ value: stable.value, revision: result.cursor.text })
      } catch (error) {
        throw contextFailure(ctx) ?? error
      }
    },
    /** Opens a source-owned Consul blocking-query watcher from the candidate revision. */
    watch(ctx: Context, revision: string | null): Promise<ConfigSourceWatcher> {
      try {
        const failure = contextFailure(ctx)
        return failure === null
          ? Promise.resolve(
              createWatcher(query, revision, minimumQueryIntervalMs, retryInitialMs, retryMaximumMs)
            )
          : Promise.reject(failure)
      } catch (error) {
        return Promise.reject(error)
      }
    }
  })
}
