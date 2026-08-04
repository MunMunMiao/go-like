import {
  objectSource,
  type ConfigObject,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher,
  type ConfigValue
} from "@go-like/config"
import { cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"

/** Executes one injected standard Web Fetch request. */
export type VaultFetch = (request: Request) => Promise<Response>

export interface VaultSourceOptions {
  readonly fetch: VaultFetch
  readonly address: string
  readonly mount: string
  readonly path: string
  readonly token?: string
  readonly name?: string
  readonly namespace?: string
  /** Selects the interval between successful KV v2 version polls; defaults to 5000 milliseconds. */
  readonly pollIntervalMs?: number
  /** Selects the first retry delay after a retryable read failure; defaults to 250 milliseconds. */
  readonly retryInitialMs?: number
  /** Caps exponential retry delay; defaults to at least 30000 milliseconds. */
  readonly retryMaximumMs?: number
}

export interface VaultHttpError extends Error {
  readonly name: "VaultHttpError"
  readonly code: "GO_LIKE_VAULT_HTTP"
  readonly status: number
}

export interface VaultTransportError extends Error {
  readonly name: "VaultTransportError"
  readonly code: "GO_LIKE_VAULT_TRANSPORT"
}

export interface VaultProtocolError extends Error {
  readonly name: "VaultProtocolError"
  readonly code: "GO_LIKE_VAULT_PROTOCOL"
}

interface CapturedOptions {
  readonly fetch: VaultFetch
  readonly address: string
  readonly mount: string
  readonly path: string
  readonly token: string | undefined
  readonly name: string
  readonly namespace: string | undefined
  readonly pollIntervalMs: number
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
}

interface QueryResult {
  readonly value: ConfigObject
  readonly revision: string
}

/** Reads one complete KV v2 response under an optional request AbortSignal. */
type VaultQuery = (signal: AbortSignal | null) => Promise<QueryResult>

const UnsafeKeys = new Set(["__proto__", "constructor", "prototype"])
const WatcherStopped = Object.freeze(new Error("Vault watcher has stopped"))
const RevisionSchemaVersion = 1
const VaultTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u

/** Converts one operation result into an owner-drain neutral barrier. */
function ignoreOperationValue(): void {}

/** Converts one operation rejection into an owner-drain neutral barrier. */
function ignoreOperationFailure(_error: unknown): void {}

/** Observes one best-effort response-body cancellation failure. */
function ignoreBodyCancellationFailure(_error: unknown): void {}

/** Returns the exact cancellation cause after one Context becomes terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Reads one own data property without invoking accessors. */
function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/** Reports whether one string contains no unpaired UTF-16 surrogate units. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

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
    if (UnsafeKeys.has(key) || !isJsonConfigValue(property(value, key))) return false
  }
  return true
}

/** Narrows validated JSON to an object root. */
function isJsonConfigObject(value: unknown): value is ConfigObject {
  return (
    value !== null && !Array.isArray(value) && typeof value === "object" && isJsonConfigValue(value)
  )
}

/** Narrows one decorated Error to the public Vault HTTP shape. */
function isHttpError(error: Error): error is VaultHttpError {
  return (
    error.name === "VaultHttpError" &&
    "code" in error &&
    error.code === "GO_LIKE_VAULT_HTTP" &&
    "status" in error &&
    typeof error.status === "number"
  )
}

/** Narrows one decorated Error to the public Vault transport shape. */
function isTransportError(error: Error): error is VaultTransportError {
  return (
    error.name === "VaultTransportError" &&
    "code" in error &&
    error.code === "GO_LIKE_VAULT_TRANSPORT"
  )
}

/** Narrows one decorated Error to the public Vault protocol shape. */
function isProtocolError(error: Error): error is VaultProtocolError {
  return (
    error.name === "VaultProtocolError" && "code" in error && error.code === "GO_LIKE_VAULT_PROTOCOL"
  )
}

/** Builds one frozen, secret-safe HTTP status error. */
function newHttpError(status: number): VaultHttpError {
  const error = new Error(`Vault KV v2 read failed with HTTP ${status}`)
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultHttpError" },
    code: { enumerable: true, value: "GO_LIKE_VAULT_HTTP" },
    status: { enumerable: true, value: status }
  })
  if (!isHttpError(error)) throw new Error("Vault HTTP error construction failed")
  return Object.freeze(error)
}

/** Builds one frozen, secret-safe transport error. */
function newTransportError(): VaultTransportError {
  const error = new Error("Vault KV v2 transport failed")
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultTransportError" },
    code: { enumerable: true, value: "GO_LIKE_VAULT_TRANSPORT" }
  })
  if (!isTransportError(error)) throw new Error("Vault transport error construction failed")
  return Object.freeze(error)
}

/** Builds one frozen, secret-safe response protocol error. */
function newProtocolError(): VaultProtocolError {
  const error = new Error("Vault KV v2 response was invalid")
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultProtocolError" },
    code: { enumerable: true, value: "GO_LIKE_VAULT_PROTOCOL" }
  })
  if (!isProtocolError(error)) throw new Error("Vault protocol error construction failed")
  return Object.freeze(error)
}

/** Classifies only transport, absence, timeout, overload, and server errors as retryable. */
function retryable(error: unknown): boolean {
  if (error instanceof Error && isTransportError(error)) return true
  if (!(error instanceof Error) || !isHttpError(error)) return false
  return (
    error.status === 404 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  )
}

/** Waits for a promise while allowing one standard AbortSignal to win. */
function waitForSignal<T>(signal: AbortSignal | null, pending: Promise<T>): Promise<T> {
  if (signal === null) return pending
  if (signal.aborted) {
    void pending.catch(ignoreOperationFailure)
    return Promise.reject(signal.reason)
  }
  const observedSignal = signal
  /** Owns one abort listener until the operation or cancellation settles. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    /** Resolves the operation and removes its abort observer. */
    function fulfilled(value: T): void {
      observedSignal.removeEventListener("abort", aborted)
      resolve(value)
    }
    /** Rejects the operation and removes its abort observer. */
    function rejected(error: unknown): void {
      observedSignal.removeEventListener("abort", aborted)
      reject(error)
    }
    /** Rejects with the exact AbortSignal reason. */
    function aborted(): void {
      reject(observedSignal.reason)
    }
    observedSignal.addEventListener("abort", aborted, { once: true })
    void pending.then(fulfilled, rejected)
  }
  return new Promise<T>(executor)
}

/** Waits for one polling or retry interval under owner and caller cancellation. */
function waitForInterval(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  /** Owns one timer and abort observer until exactly one wins. */
  function executor(resolve: () => void, reject: (error: unknown) => void): void {
    /** Resolves the interval and removes its abort observer. */
    function elapsed(): void {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    /** Rejects the interval and clears its timer. */
    function aborted(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(elapsed, timeoutMs)
    signal.addEventListener("abort", aborted, { once: true })
  }
  return new Promise<void>(executor)
}

/** Starts best-effort error body cancellation without overriding the HTTP status. */
function discardBody(response: Response): void {
  const body = response.body
  if (body === null) return
  void Promise.resolve(body.cancel()).catch(ignoreBodyCancellationFailure)
}

/** Reports whether one value is a canonical Vault RFC3339Nano timestamp. */
function isVaultTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isWellFormed(value) &&
    VaultTimestamp.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

/** Encodes one version-specific Vault secret generation as an opaque revision token. */
function encodeRevision(version: number, createdTime: string): string {
  return JSON.stringify([RevisionSchemaVersion, version, createdTime])
}

/** Accepts current generation tokens and legacy decimal versions for one safe resync. */
function isRevision(value: string): boolean {
  if (/^[1-9][0-9]*$/u.test(value)) return true
  if (value.length > 256) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return false
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return false
  const schema = parsed[0]
  const version = parsed[1]
  const createdTime = parsed[2]
  return (
    schema === RevisionSchemaVersion &&
    Number.isSafeInteger(version) &&
    Number(version) >= 1 &&
    isVaultTimestamp(createdTime) &&
    JSON.stringify(parsed) === value
  )
}

/** Parses and validates one complete Vault KV v2 read response. */
function parseResponse(text: string): QueryResult {
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw newProtocolError()
  }
  const data = property(envelope, "data")
  const value = property(data, "data")
  const metadata = property(data, "metadata")
  const version = property(metadata, "version")
  const createdTime = property(metadata, "created_time")
  if (
    !isJsonConfigObject(value) ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1 ||
    !isVaultTimestamp(createdTime)
  ) {
    throw newProtocolError()
  }
  return Object.freeze({ value, revision: encodeRevision(Number(version), createdTime) })
}

/** Encodes one strict slash-separated Vault route without URL-normalized dot segments. */
function route(value: string, label: string): string {
  if (!isWellFormed(value)) throw new TypeError(`Vault ${label} contains invalid UTF-16`)
  const segments = value.split("/")
  const encoded: string[] = []
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new TypeError(`Vault ${label} contains an invalid path segment`)
    }
    encoded.push(encodeURIComponent(segment))
  }
  return encoded.join("/")
}

/** Validates one bare HTTP(S) Vault origin. */
function vaultOrigin(address: string): URL {
  let origin: URL
  try {
    origin = new URL(address)
  } catch {
    throw new TypeError("Vault address must be a valid HTTP or HTTPS origin")
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError("Vault address must use HTTP or HTTPS")
  }
  if (
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.pathname !== "" && origin.pathname !== "/") ||
    origin.href.includes("?") ||
    origin.href.includes("#")
  ) {
    throw new TypeError("Vault address must be an origin without credentials or route components")
  }
  return origin
}

/** Validates one optional secret-safe HTTP header value without retaining the resulting Headers. */
function headerValue(value: string | undefined, label: string): void {
  if (value === undefined) return
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError(`Vault ${label} must be a non-empty HTTP header value`)
  }
  try {
    const headers = new Headers()
    headers.set("X-go-like-Validation", value)
  } catch {
    throw new TypeError(`Vault ${label} must be a non-empty HTTP header value`)
  }
}

/** Validates one bounded positive millisecond option. */
function duration(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Vault ${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Captures option properties without allowing hostile accessors to leak values. */
function captureOptions(options: VaultSourceOptions): CapturedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Vault source options must be an object")
  }
  try {
    const name = options.name
    const pollIntervalMs = options.pollIntervalMs
    const retryInitialMs = options.retryInitialMs
    const retryMaximumMs = options.retryMaximumMs
    const capturedRetryInitialMs = retryInitialMs === undefined ? 250 : retryInitialMs
    return {
      fetch: options.fetch,
      address: options.address,
      mount: options.mount,
      path: options.path,
      token: options.token,
      name: name === undefined ? "vault" : name,
      namespace: options.namespace,
      pollIntervalMs: pollIntervalMs === undefined ? 5_000 : pollIntervalMs,
      retryInitialMs: capturedRetryInitialMs,
      retryMaximumMs:
        retryMaximumMs === undefined ? Math.max(30_000, capturedRetryInitialMs) : retryMaximumMs
    }
  } catch {
    throw new TypeError("Vault source options could not be read")
  }
}

/** Creates one source-owned polling watcher with Context-aware stop. */
function createWatcher(
  query: VaultQuery,
  revision: string | null,
  pollIntervalMs: number,
  retryInitialMs: number,
  retryMaximumMs: number
): ConfigSourceWatcher {
  if (revision !== null && !isRevision(revision)) {
    throw new TypeError("Vault watcher revision must be a valid opaque token")
  }
  let current = revision
  let active: Promise<void> | null = null
  let waiting = false
  let stopped = false
  let shutdown: Promise<void> | null = null
  const controller = new AbortController()

  /** Maps an interrupted timer to caller cancellation or owner shutdown. */
  function watcherInterval(ctx: Context, signal: AbortSignal, timeoutMs: number): Promise<void> {
    /** Selects the highest-authority visible interruption reason. */
    function rejected(error: unknown): Promise<never> {
      return Promise.reject(contextFailure(ctx) ?? (stopped ? WatcherStopped : error))
    }
    return waitForInterval(signal, timeoutMs).catch(rejected)
  }

  /** Polls until the validated KV v2 metadata version changes. */
  async function runNext(ctx: Context): Promise<void> {
    try {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const callerSignal = ctx.done()
      const signal =
        callerSignal === null
          ? controller.signal
          : AbortSignal.any([callerSignal, controller.signal])
      let delayMs = pollIntervalMs
      let retryDelayMs = retryInitialMs
      while (true) {
        await watcherInterval(ctx, signal, delayMs)
        let result: QueryResult
        try {
          result = await query(signal)
          const failure = contextFailure(ctx)
          if (failure !== null) throw failure
          if (stopped) throw WatcherStopped
        } catch (error) {
          const failure = contextFailure(ctx)
          if (failure !== null) throw failure
          if (stopped) throw WatcherStopped
          if (!retryable(error)) throw error
          delayMs = retryDelayMs
          retryDelayMs = Math.min(retryMaximumMs, retryDelayMs * 2)
          continue
        }
        delayMs = pollIntervalMs
        retryDelayMs = retryInitialMs
        if (current === null) {
          current = result.revision
        } else if (result.revision !== current) {
          current = result.revision
          return
        }
      }
    } finally {
      waiting = false
    }
  }

  return Object.freeze({
    /** Waits until a real KV v2 metadata version change is observed. */
    next(ctx: Context): Promise<void> {
      if (stopped) return Promise.reject(WatcherStopped)
      if (waiting) return Promise.reject(new Error("Vault watcher is already waiting"))
      waiting = true
      const operation = runNext(ctx)
      active = operation.then(ignoreOperationValue, ignoreOperationFailure)
      return operation
    },
    /** Aborts and drains active polling. */
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

/** Creates a strict KV v2 configuration source using only an injected standard Fetch capability. */
export function vaultSource(options: VaultSourceOptions): ConfigSource {
  const captured = captureOptions(options)
  if (typeof captured.fetch !== "function") {
    throw new TypeError("Vault Fetch capability must be callable")
  }
  if (typeof captured.address !== "string") throw new TypeError("Vault address must be a string")
  const origin = vaultOrigin(captured.address)
  if (typeof captured.mount !== "string" || captured.mount.length === 0) {
    throw new TypeError("Vault mount must be non-empty")
  }
  if (typeof captured.path !== "string" || captured.path.length === 0) {
    throw new TypeError("Vault path must be non-empty")
  }
  const mount = route(captured.mount, "mount")
  const path = route(captured.path, "path")
  if (typeof captured.name !== "string" || captured.name.length === 0) {
    throw new TypeError("Vault source name must be non-empty")
  }
  headerValue(captured.token, "token")
  headerValue(captured.namespace, "namespace")
  const pollIntervalMs = duration(captured.pollIntervalMs, 1, 600_000, "pollIntervalMs")
  const retryInitialMs = duration(captured.retryInitialMs, 1, 60_000, "retryInitialMs")
  const retryMaximumMs = duration(
    captured.retryMaximumMs,
    retryInitialMs,
    600_000,
    "retryMaximumMs"
  )
  const url = new URL(`/v1/${mount}/data/${path}`, origin)

  /** Performs one complete status-authoritative, abort-bounded KV v2 read. */
  async function query(signal: AbortSignal | null): Promise<QueryResult> {
    const headers = new Headers({ Accept: "application/json" })
    if (captured.token !== undefined) headers.set("X-Vault-Token", captured.token)
    if (captured.namespace !== undefined) headers.set("X-Vault-Namespace", captured.namespace)
    const request =
      signal === null
        ? new Request(url, { headers, redirect: "error" })
        : new Request(url, { headers, redirect: "error", signal })
    let pending: Promise<Response>
    try {
      pending = Promise.resolve(captured.fetch(request))
    } catch {
      throw newTransportError()
    }
    let response: Response
    try {
      response = await waitForSignal(signal, pending)
    } catch {
      if (signal !== null && signal.aborted) throw signal.reason
      throw newTransportError()
    }
    if (!(response instanceof Response)) throw newProtocolError()
    if (!response.ok) {
      discardBody(response)
      throw newHttpError(response.status)
    }
    let body: Promise<string>
    try {
      body = Promise.resolve(response.text())
    } catch {
      throw newTransportError()
    }
    let text: string
    try {
      text = await waitForSignal(signal, body)
    } catch {
      if (signal !== null && signal.aborted) throw signal.reason
      throw newTransportError()
    }
    return parseResponse(text)
  }

  return Object.freeze({
    name: captured.name,
    /** Loads one complete KV v2 data object and metadata version. */
    async load(ctx: Context): Promise<ConfigSourceSnapshot> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      try {
        const result = await query(ctx.done())
        const queryFailure = contextFailure(ctx)
        if (queryFailure !== null) throw queryFailure
        const stable = await objectSource(captured.name, result.value).load(ctx)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return Object.freeze({ value: stable.value, revision: result.revision })
      } catch (error) {
        throw contextFailure(ctx) ?? error
      }
    },
    /** Opens one owner-managed KV v2 polling watcher from the supplied revision. */
    watch(ctx: Context, revision: string | null): Promise<ConfigSourceWatcher> {
      try {
        const failure = contextFailure(ctx)
        return failure === null
          ? Promise.resolve(
              createWatcher(query, revision, pollIntervalMs, retryInitialMs, retryMaximumMs)
            )
          : Promise.reject(failure)
      } catch (error) {
        return Promise.reject(error)
      }
    }
  })
}
