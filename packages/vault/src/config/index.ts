import {
  jsonDecoder,
  objectSource,
  type ConfigObject,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher
} from "@go-like/core/config"
import { cause, type Context } from "@go-like/core/context"
import { newConfigSourceMissingError } from "@go-like/core/config/provider"
import { waitForContext } from "@go-like/core/context"

import { openVaultClient, type VaultClient } from "../client/client"
import {
  newVaultHttpError,
  newVaultProtocolError,
  newVaultTransportError,
  vaultHttpCode,
  vaultTransportCode
} from "../client/errors"
import { secretBearing, vaultHeaders, vaultHttpRequest } from "../client/http"
import { configReadOperation, vaultKvPath } from "../client/kv2"
import type { Connection } from "../client/options"

/** vaultSource options. Connection fields live on VaultClientOptions. */
export interface VaultSourceOptions {
  /** KV v2 mount, for example "secret". */
  readonly mount: string
  /** Secret path under the mount. */
  readonly path: string
  /** Default "vault". */
  readonly name?: string
  /** Selects the interval between successful KV v2 version polls; defaults to 5000 milliseconds. */
  readonly pollIntervalMs?: number
  /** Selects the first retry delay after a retryable read failure; defaults to 250 milliseconds. */
  readonly retryInitialMs?: number
  /** Caps exponential retry delay; defaults to at least 30000 milliseconds. */
  readonly retryMaximumMs?: number
  /** When true an absent secret loads as {}; default false rejects with ConfigSourceMissingError. */
  readonly optional?: boolean
}

interface CapturedSource {
  readonly mount: string
  readonly path: string
  readonly name: string
  readonly pollIntervalMs: number
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
  readonly optional: boolean
}

type QueryResult =
  | { readonly missing: true; readonly revision: string }
  | { readonly missing: false; readonly value: ConfigObject; readonly revision: string }

/** Reads one complete KV v2 response under an optional request AbortSignal. */
type VaultQuery = (signal: AbortSignal | null) => Promise<QueryResult>

const WatcherStopped = Object.freeze(new Error("Vault watcher has stopped"))
const RevisionSchemaVersion = 1
const AbsentRevision = JSON.stringify([0])
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

/** Classifies transport, timeout, overload, and server errors as retryable. Absence is not a failure. */
function retryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  if (error.code === vaultTransportCode) return true
  if (error.code !== vaultHttpCode || !("status" in error) || typeof error.status !== "number") {
    return false
  }
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
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
    value.isWellFormed() &&
    VaultTimestamp.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

/** Encodes one version-specific Vault secret generation as an opaque revision token. */
function encodeRevision(version: number, createdTime: string): string {
  return JSON.stringify([RevisionSchemaVersion, version, createdTime])
}

/** Accepts absence, current generation tokens, and legacy decimal versions. */
function isRevision(value: string): boolean {
  if (value === AbsentRevision) return true
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

/** Decodes one secret document with the core JSON decoder and hides its text. */
function decodeDocument(value: unknown, path: string): ConfigObject {
  const text = JSON.stringify(value)
  if (typeof text !== "string") throw newVaultProtocolError(configReadOperation)
  try {
    return jsonDecoder(text, path)
  } catch {
    throw newVaultProtocolError(configReadOperation)
  }
}

/** Parses and validates one complete Vault KV v2 read response. */
function parseResponse(text: string, path: string): QueryResult {
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw newVaultProtocolError(configReadOperation)
  }
  const data = property(envelope, "data")
  const value = property(data, "data")
  const metadata = property(data, "metadata")
  const version = property(metadata, "version")
  const createdTime = property(metadata, "created_time")
  if (!Number.isSafeInteger(version) || Number(version) < 1 || !isVaultTimestamp(createdTime)) {
    throw newVaultProtocolError(configReadOperation)
  }
  return Object.freeze({
    missing: false,
    value: decodeDocument(value, path),
    revision: encodeRevision(Number(version), createdTime)
  })
}

/** Encodes one strict slash-separated Vault route without URL-normalized dot segments. */
function route(value: string, label: string): string {
  if (!value.isWellFormed()) throw new TypeError(`Vault ${label} contains invalid UTF-16`)
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

/** Validates one bounded positive millisecond option. */
function duration(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Vault ${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Captures source fields without allowing hostile accessors to leak values. */
function captureSourceOptions(options: VaultSourceOptions): CapturedSource {
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
      mount: options.mount,
      path: options.path,
      name: name === undefined ? "vault" : name,
      pollIntervalMs: pollIntervalMs === undefined ? 5_000 : pollIntervalMs,
      retryInitialMs: capturedRetryInitialMs,
      retryMaximumMs:
        retryMaximumMs === undefined ? Math.max(30_000, capturedRetryInitialMs) : retryMaximumMs,
      optional: options.optional === true
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

  /** Polls until the validated KV v2 metadata version or presence changes. */
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
    /** Waits until a real KV v2 metadata version or presence change is observed. */
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

/** Creates a strict KV v2 configuration source on a shared Vault client. */
export function vaultSource(client: VaultClient, options: VaultSourceOptions): ConfigSource {
  const connection: Connection = openVaultClient(client)
  const captured = captureSourceOptions(options)
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
  const pollIntervalMs = duration(captured.pollIntervalMs, 1, 600_000, "pollIntervalMs")
  const retryInitialMs = duration(captured.retryInitialMs, 1, 60_000, "retryInitialMs")
  const retryMaximumMs = duration(
    captured.retryMaximumMs,
    retryInitialMs,
    600_000,
    "retryMaximumMs"
  )
  const url = new URL(vaultKvPath(mount, "data", path), connection.origin)
  const secret = secretBearing(connection.token, connection.namespace)
  const optional = captured.optional

  /** Performs one complete status-authoritative, abort-bounded KV v2 read. */
  async function query(signal: AbortSignal | null): Promise<QueryResult> {
    const request = vaultHttpRequest(
      url,
      "GET",
      vaultHeaders(connection.token, connection.namespace, false),
      null,
      signal
    )
    let pending: Promise<Response>
    try {
      pending = Promise.resolve(connection.fetch(request))
    } catch (value) {
      throw newVaultTransportError(configReadOperation, value, secret)
    }
    let response: Response
    try {
      response = await waitForSignal(signal, pending)
    } catch (value) {
      if (signal !== null && signal.aborted) throw signal.reason
      throw newVaultTransportError(configReadOperation, value, secret)
    }
    if (!(response instanceof Response)) throw newVaultProtocolError(configReadOperation)
    if (response.status === 404) {
      discardBody(response)
      return Object.freeze({ missing: true, revision: AbsentRevision })
    }
    if (!response.ok) {
      discardBody(response)
      throw newVaultHttpError(configReadOperation, response.status)
    }
    let body: Promise<string>
    try {
      body = Promise.resolve(response.text())
    } catch (value) {
      throw newVaultTransportError(configReadOperation, value, secret)
    }
    let text: string
    try {
      text = await waitForSignal(signal, body)
    } catch (value) {
      if (signal !== null && signal.aborted) throw signal.reason
      throw newVaultTransportError(configReadOperation, value, secret)
    }
    return parseResponse(text, captured.path)
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
        if (result.missing) {
          if (!optional) throw newConfigSourceMissingError(captured.name)
          const stable = await objectSource(captured.name, {}).load(ctx)
          const missingFailure = contextFailure(ctx)
          if (missingFailure !== null) throw missingFailure
          return Object.freeze({ value: stable.value, revision: result.revision })
        }
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
