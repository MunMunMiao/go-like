import {
  jsonDecoder,
  objectSource,
  type ConfigDecoder,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher
} from "@go-like/core/config"
import { cause, type Context } from "@go-like/core/context"
import { newConfigSourceMissingError } from "@go-like/core/config/provider"
import { waitForContext } from "@go-like/core/context"

import { openEtcdClient, type EtcdClient } from "../client/client"
import {
  newEtcdHttpError,
  newEtcdProtocolError,
  newEtcdTransportError,
  type EtcdHttpError,
  type EtcdProtocolError,
  type EtcdTransportError
} from "../client/errors"
import { etcdHeaders, etcdUrl } from "../client/http"
import type { Connection } from "../client/options"

/** etcdSource options. Connection fields live on EtcdClientOptions. */
export interface EtcdSourceOptions {
  readonly key: string
  /** Default "etcd". */
  readonly name?: string
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Decodes complete KV text; defaults to jsonDecoder. */
  readonly decode?: ConfigDecoder
  /** When true an absent key loads as {}; default false rejects with ConfigSourceMissingError. */
  readonly optional?: boolean
}

interface Revision {
  readonly text: string
  readonly value: bigint
}

interface RangeResult {
  readonly text: string | null
  readonly revision: Revision
}

interface WatchChanged {
  readonly kind: "changed"
  readonly revision: Revision
}

interface WatchCompacted {
  readonly kind: "compacted"
}

type WatchOutcome = WatchChanged | WatchCompacted
type ConfigWireOperation = "range" | "watch"

const WatcherStopped = Object.freeze(new Error("etcd watcher has stopped"))
const MaximumWatchFrameBytes = 1_048_576

/** Ignores one best-effort response-body cancellation failure. */
function ignoreCancellationFailure(_error: unknown): void {}

/** Converts an operation success into an owner-drain neutral value. */
function ignoreOperationValue(): void {}

/** Converts an operation rejection into an owner-drain neutral value. */
function ignoreOperationFailure(_error: unknown): void {}

/** Reads one own data property without invoking accessors. */
function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/** Returns the caller's exact Context cancellation cause when terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Encodes UTF-8 text using the base64 representation required by the etcd JSON gateway. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Decodes one strict base64 UTF-8 field without retaining malformed gateway data. */
function decodeBase64(value: unknown, operation: ConfigWireOperation): string {
  if (typeof value !== "string") throw newProtocolError(operation)
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw newProtocolError(operation)
  }
}

/** Parses one opaque decimal etcd revision without converting it through Number. */
function revision(value: unknown, operation: ConfigWireOperation): Revision {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw newProtocolError(operation)
  }
  return Object.freeze({ text: value, value: BigInt(value) })
}

/** Reads the required response header revision. */
function responseRevision(value: unknown, operation: ConfigWireOperation): Revision {
  return revision(property(property(value, "header"), "revision"), operation)
}

/** Builds one secret-safe HTTP boundary error. Registry and config discard the body, so grpcCode is absent. */
function newHttpError(operation: ConfigWireOperation, status: number): EtcdHttpError {
  return newEtcdHttpError(`config.${operation}`, status, null)
}

/** Builds one secret-safe transport boundary error. */
function newTransportError(
  operation: ConfigWireOperation,
  value: unknown,
  secretBoundary: boolean
): EtcdTransportError {
  return newEtcdTransportError(`config.${operation}`, value, secretBoundary)
}

/** Builds one secret-safe gateway protocol error. */
function newProtocolError(operation: ConfigWireOperation): EtcdProtocolError {
  return newEtcdProtocolError(`config.${operation}`)
}

/** Starts a non-blocking body cancellation so HTTP status remains authoritative. */
function discardBody(response: Response): void {
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    return
  }
  if (body === null) return
  try {
    void Promise.resolve(body.cancel()).catch(ignoreCancellationFailure)
  } catch {
    return
  }
}

/** Waits for one promise while allowing an AbortSignal to win non-cooperative test capabilities. */
function waitForSignal<T>(signal: AbortSignal | null, pending: Promise<T>): Promise<T> {
  if (signal === null) return pending
  if (signal.aborted) {
    void pending.catch(ignoreOperationFailure)
    return Promise.reject(signal.reason)
  }
  const observedSignal = signal
  /** Owns one abort listener until either branch settles. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    /** Resolves the operation branch and detaches its cancellation observer. */
    function fulfilled(value: T): void {
      observedSignal.removeEventListener("abort", aborted)
      resolve(value)
    }
    /** Rejects the operation branch and detaches its cancellation observer. */
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

/** Waits for one retry interval while preserving the exact AbortSignal reason. */
function waitForInterval(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  /** Owns one timer and one abort observer until exactly one wins. */
  function executor(resolve: () => void, reject: (error: unknown) => void): void {
    /** Resolves the elapsed interval and removes its abort observer. */
    function elapsed(): void {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    /** Rejects the interval with the exact owner or caller reason. */
    function aborted(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(elapsed, timeoutMs)
    signal.addEventListener("abort", aborted, { once: true })
  }
  return new Promise<void>(executor)
}

/** Classifies only transport, overload, timeout, and server failures as retryable. */
function retryable(value: unknown): boolean {
  if (property(value, "code") === "GO_LIKE_ETCD_TRANSPORT") return true
  if (property(value, "code") !== "GO_LIKE_ETCD_HTTP") return false
  const status = property(value, "status")
  return (
    typeof status === "number" &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  )
}

/** Parses one exact range response and retains only value text plus global revision. */
function parseRangeResponse(value: unknown): RangeResult {
  const current = responseRevision(value, "range")
  const kvs = property(value, "kvs")
  if (kvs === undefined) return Object.freeze({ text: null, revision: current })
  if (!Array.isArray(kvs) || kvs.length > 1) throw newProtocolError("range")
  const entry = kvs[0]
  if (entry === undefined) return Object.freeze({ text: null, revision: current })
  return Object.freeze({ text: decodeBase64(property(entry, "value"), "range"), revision: current })
}

/** Classifies one newline-delimited etcd watch result frame. */
function parseWatchFrame(line: string): WatchOutcome | null {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    throw newProtocolError("watch")
  }
  const result = property(envelope, "result")
  if (result === undefined) throw newProtocolError("watch")
  if (property(result, "canceled") === true) {
    const compact = property(result, "compact_revision")
    if (typeof compact === "string" && revision(compact, "watch").value > 0n) {
      return Object.freeze({ kind: "compacted" })
    }
    throw newProtocolError("watch")
  }
  const events = property(result, "events")
  if (events !== undefined) {
    if (!Array.isArray(events)) throw newProtocolError("watch")
    if (events.length > 0) {
      return Object.freeze({ kind: "changed", revision: responseRevision(result, "watch") })
    }
  }
  if (property(result, "created") === true || property(result, "header") !== undefined) return null
  throw newProtocolError("watch")
}

/**
 * Creates an etcd ConfigSource over the v3 JSON gateway and standard Web streams.
 *
 * An absent key rejects unless optional is set. A watch transition between present and absent
 * is a change: the watcher reports it and does not fail.
 */
export function etcdSource(client: EtcdClient, options: EtcdSourceOptions): ConfigSource {
  const connection: Connection = openEtcdClient(client)
  if (options === null || typeof options !== "object") {
    throw new TypeError("etcd options must be an object")
  }
  const fetch = connection.fetch
  const origin = connection.origin
  const token = connection.token
  const key = options.key
  const name = options.name ?? "etcd"
  const retryInitialMs = options.retryInitialMs ?? 250
  const retryMaximumMs = options.retryMaximumMs ?? Math.max(30_000, retryInitialMs)
  const decode = options.decode ?? jsonDecoder
  const optional = options.optional === true
  if (typeof key !== "string" || key.length === 0 || !key.isWellFormed()) {
    throw new TypeError("etcd key must be a non-empty well-formed string")
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("etcd source name must be non-empty")
  }
  if (!Number.isInteger(retryInitialMs) || retryInitialMs < 1 || retryInitialMs > 60_000) {
    throw new TypeError("etcd retryInitialMs must be an integer from 1 through 60000")
  }
  if (
    !Number.isInteger(retryMaximumMs) ||
    retryMaximumMs < retryInitialMs ||
    retryMaximumMs > 600_000
  ) {
    throw new TypeError("etcd retryMaximumMs must be from retryInitialMs through 600000")
  }
  if (typeof decode !== "function") throw new TypeError("etcd decoder must be callable")
  const encodedKey = encodeBase64(key)
  const secret = token !== undefined

  /** Performs one status-authoritative JSON gateway request. */
  async function request(
    operation: ConfigWireOperation,
    path: string,
    body: string,
    signal: AbortSignal | null
  ): Promise<Response> {
    const init: RequestInit = {
      body,
      headers: etcdHeaders(token),
      method: "POST",
      redirect: "error"
    }
    if (signal !== null) init.signal = signal
    let response: Response
    try {
      response = await waitForSignal(
        signal,
        Promise.resolve(fetch(new Request(etcdUrl(origin, path), init)))
      )
    } catch (value) {
      if (signal !== null && signal.aborted) throw signal.reason
      throw newTransportError(operation, value, secret)
    }
    if (!response.ok) {
      discardBody(response)
      throw newHttpError(operation, response.status)
    }
    return response
  }

  /** Reads one complete successful JSON response within the operation signal. */
  async function responseJson(
    operation: ConfigWireOperation,
    response: Response,
    signal: AbortSignal | null
  ): Promise<unknown> {
    let pending: Promise<string>
    try {
      pending = Promise.resolve(response.text())
    } catch (value) {
      throw newTransportError(operation, value, secret)
    }
    let text: string
    try {
      text = await waitForSignal(signal, pending)
    } catch (value) {
      if (signal !== null && signal.aborted) throw signal.reason
      throw newTransportError(operation, value, secret)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw newProtocolError(operation)
    }
  }

  /** Loads one exact key together with the global revision needed for a gap-free watch. */
  async function range(signal: AbortSignal | null): Promise<RangeResult> {
    const response = await request(
      "range",
      "/v3/kv/range",
      JSON.stringify({ key: encodedKey }),
      signal
    )
    return parseRangeResponse(await responseJson("range", response, signal))
  }

  /** Reads a stream until one mutation or compaction result becomes observable. */
  async function watchOnce(signal: AbortSignal, startRevision: Revision): Promise<WatchOutcome> {
    const response = await request(
      "watch",
      "/v3/watch",
      JSON.stringify({
        create_request: {
          key: encodedKey,
          progress_notify: true,
          start_revision: startRevision.text
        }
      }),
      signal
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      const body = response.body
      if (body === null) throw newProtocolError("watch")
      reader = body.getReader()
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let buffered = ""
      while (true) {
        let chunk
        try {
          chunk = await waitForSignal(signal, reader.read())
        } catch (value) {
          if (signal.aborted) throw signal.reason
          throw newTransportError("watch", value, secret)
        }
        try {
          buffered += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
        } catch {
          throw newProtocolError("watch")
        }
        if (buffered.length > MaximumWatchFrameBytes) throw newProtocolError("watch")
        let newline = buffered.indexOf("\n")
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          if (line !== "") {
            const outcome = parseWatchFrame(line)
            if (outcome !== null) return outcome
          }
          newline = buffered.indexOf("\n")
        }
        if (chunk.done) {
          const line = buffered.trim()
          if (line !== "") {
            const outcome = parseWatchFrame(line)
            if (outcome !== null) return outcome
          }
          throw newTransportError("watch", new Error("etcd config watch stream ended"), secret)
        }
      }
    } finally {
      if (reader !== null) {
        try {
          void reader.cancel().catch(ignoreCancellationFailure)
        } catch {
          ignoreCancellationFailure(undefined)
        }
      }
    }
  }

  /** Creates one source-owned watch cursor with retry and compaction reconciliation. */
  function createWatcher(candidate: string | null): ConfigSourceWatcher {
    let current = candidate === null ? revision("0", "watch") : revision(candidate, "watch")
    let active: Promise<void> | null = null
    let waiting = false
    let stopped = false
    let shutdown: Promise<void> | null = null
    const controller = new AbortController()

    /** Runs watches until one change or post-failure reconciliation is ready. */
    async function runNext(ctx: Context): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const callerSignal = ctx.done()
      const signal =
        callerSignal === null
          ? controller.signal
          : AbortSignal.any([callerSignal, controller.signal])
      let recovering = false
      let retryDelayMs = retryInitialMs
      try {
        while (true) {
          try {
            if (recovering) {
              const recovered = await range(signal)
              current = recovered.revision
              return
            }
            const start = Object.freeze({
              text: String(current.value + 1n),
              value: current.value + 1n
            })
            const outcome = await watchOnce(signal, start)
            if (outcome.kind === "changed") {
              current = outcome.revision
              return
            }
            const recovered = await range(signal)
            current = recovered.revision
            return
          } catch (error) {
            const failure = contextFailure(ctx)
            if (failure !== null) throw failure
            if (stopped) throw WatcherStopped
            if (!retryable(error)) throw error
            recovering = true
            try {
              await waitForInterval(signal, retryDelayMs)
            } catch (intervalError) {
              const intervalFailure = contextFailure(ctx)
              if (intervalFailure !== null) throw intervalFailure
              if (stopped) throw WatcherStopped
              throw intervalError
            }
            retryDelayMs = Math.min(retryMaximumMs, retryDelayMs * 2)
          }
        }
      } finally {
        waiting = false
      }
    }

    return Object.freeze({
      /** Waits for one exact-key mutation or a required reconciliation. */
      next(ctx: Context): Promise<void> {
        if (stopped) return Promise.reject(WatcherStopped)
        if (waiting) return Promise.reject(new Error("etcd watcher is already waiting"))
        waiting = true
        const operation = runNext(ctx)
        active = operation.then(ignoreOperationValue, ignoreOperationFailure)
        return operation
      },
      /** Aborts and drains the active stream. */
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

  return Object.freeze({
    name,
    /** Loads, decodes, validates, and snapshots the exact key at a linearizable revision. */
    async load(ctx: Context): Promise<ConfigSourceSnapshot> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      try {
        const result = await range(ctx.done())
        const queryFailure = contextFailure(ctx)
        if (queryFailure !== null) throw queryFailure
        if (result.text === null && !optional) throw newConfigSourceMissingError(name)
        const decoded = result.text === null ? {} : decode(result.text, key)
        const stable = await objectSource(name, decoded).load(ctx)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return Object.freeze({ value: stable.value, revision: result.revision.text })
      } catch (error) {
        throw contextFailure(ctx) ?? error
      }
    },
    /** Opens one source-owned exact-key watch from the supplied global revision. */
    watch(ctx: Context, candidate: string | null): Promise<ConfigSourceWatcher> {
      try {
        const failure = contextFailure(ctx)
        return failure === null
          ? Promise.resolve(createWatcher(candidate))
          : Promise.reject(failure)
      } catch (error) {
        return Promise.reject(error)
      }
    }
  })
}
