import {
  jsonDecoder,
  objectSource,
  type ConfigDecoder,
  type ConfigObject,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher
} from "@go-like/core/config"
import { cause, type Context } from "@go-like/core/context"
import { newConfigSourceMissingError } from "@go-like/core/config/provider"
import { waitForContext } from "@go-like/core/context"

import { openKubernetesClient, type KubernetesClient } from "../client/client"
import {
  configOperation,
  newKubernetesHttpError,
  newKubernetesProtocolError,
  newKubernetesTransportError,
  type KubernetesHttpError,
  type KubernetesProtocolError,
  type KubernetesTransportError
} from "../client/errors"
import { configWatchExpired, kubernetesHeaders, retryableConfigFailure } from "../client/http"
import { kubernetesKey, kubernetesNamespace, kubernetesResourceName } from "../client/names"

/**
 * Exactly one of ConfigMap or Secret. Connection fields live on KubernetesClient.
 */
export type KubernetesSourceObject =
  | { readonly configMap: string; readonly secret?: never }
  | { readonly secret: string; readonly configMap?: never }

/** kubernetesSource options. `name` was `sourceName`. */
export type KubernetesSourceOptions = KubernetesSourceObject & {
  readonly namespace: string
  /** Key inside data. Secret values are base64-decoded. */
  readonly key: string
  /** Source name, default "kubernetes". */
  readonly name?: string
  /** Bound of get and list requests, default 10000. */
  readonly timeoutMs?: number
  /** Server-side watch timeout, default 300. */
  readonly watchTimeoutSeconds?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Default jsonDecoder from @go-like/core/config. */
  readonly decode?: ConfigDecoder
  /** When true an absent object or key loads as {}. Default false throws ConfigSourceMissingError. */
  readonly optional?: boolean
}

type Kind = "ConfigMap" | "Secret"
type Operation = "get" | "list" | "watch"

interface ListedResource {
  readonly resourceVersion: string
  readonly present: boolean
}

interface LoadedDocument {
  readonly missing: false
  readonly text: string
  readonly resourceVersion: string
}

interface MissingDocument {
  readonly missing: true
  readonly resourceVersion: string | null
}

type LoadedKey = LoadedDocument | MissingDocument

interface WatchChanged {
  readonly kind: "changed"
  readonly resourceVersion: string
}

interface WatchEnded {
  readonly kind: "ended"
  readonly resourceVersion: string
}

interface WatchExpired {
  readonly kind: "expired"
}

type WatchOutcome = WatchChanged | WatchEnded | WatchExpired

const WatcherStopped = Object.freeze(new Error("Kubernetes configuration watcher has stopped"))
const OperationTimedOut = Object.freeze(new Error("Kubernetes configuration operation timed out"))
const MaximumWatchFrameBytes = 1_048_576

/** Drains one best-effort promise without surfacing its terminal value. */
async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch {
    return
  }
}

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

/** Creates one shared HTTP error for a config operation. */
function httpError(operation: Operation, status: number): KubernetesHttpError {
  return newKubernetesHttpError(configOperation(operation), status)
}

/** Creates one shared protocol error for a config operation. */
function protocolError(operation: Operation): KubernetesProtocolError {
  return newKubernetesProtocolError(configOperation(operation))
}

/** Creates one shared transport error for a config operation. */
function transportError(
  operation: Operation,
  value: unknown,
  secretBoundary: boolean
): KubernetesTransportError {
  return newKubernetesTransportError(configOperation(operation), value, secretBoundary)
}

/** Reports whether a config GET failed because the object does not exist. */
function missingObject(value: unknown): boolean {
  return (
    property(value, "code") === "GO_LIKE_KUBERNETES_HTTP" &&
    property(value, "status") === 404 &&
    property(value, "operation") === "config.get"
  )
}

/** Starts best-effort response-body cancellation without weakening status authority. */
function discardBody(response: Response): void {
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    return
  }
  if (body === null) return
  try {
    void settle(Promise.resolve(body.cancel()))
  } catch {
    return
  }
}

/** Waits for one promise while allowing a cooperative Context signal to win. */
function waitForSignal<T>(signal: AbortSignal | null, pending: Promise<T>): Promise<T> {
  if (signal === null) return pending
  if (signal.aborted) {
    void settle(pending)
    return Promise.reject(signal.reason)
  }
  const observedSignal = signal
  /** Owns one cancellation observer until either branch settles. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    /** Resolves and detaches the abort observer. */
    function fulfilled(value: T): void {
      observedSignal.removeEventListener("abort", fulfilledAbort)
      resolve(value)
    }
    /** Rejects and detaches the abort observer. */
    function rejected(error: unknown): void {
      observedSignal.removeEventListener("abort", fulfilledAbort)
      reject(error)
    }
    /** Rejects with the exact AbortSignal reason. */
    function fulfilledAbort(): void {
      reject(observedSignal.reason)
    }
    observedSignal.addEventListener("abort", fulfilledAbort, { once: true })
    void pending.then(fulfilled, rejected)
  }
  return new Promise<T>(executor)
}

/** Waits for one retry interval while preserving the exact signal reason. */
function waitForInterval(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  /** Owns one timer and abort observer until exactly one wins. */
  function executor(resolve: () => void, reject: (error: unknown) => void): void {
    /** Resolves after the retry delay. */
    function elapsed(): void {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    /** Rejects with the owner or caller reason. */
    function aborted(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(elapsed, timeoutMs)
    signal.addEventListener("abort", aborted, { once: true })
  }
  return new Promise<void>(executor)
}

/** Bounds one non-resident operation while preserving caller or owner cancellation. */
async function withOperationTimeout<T>(
  signal: AbortSignal | null,
  timeoutMs: number,
  operation: Operation,
  secretBoundary: boolean,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal?.aborted === true) throw signal.reason
  const controller = new AbortController()
  /** Propagates the caller or owner reason exactly. */
  function aborted(): void {
    if (!controller.signal.aborted && signal !== null) controller.abort(signal.reason)
  }
  signal?.addEventListener("abort", aborted, { once: true })
  const timer = setTimeout(function timedOut(): void {
    if (!controller.signal.aborted) controller.abort(OperationTimedOut)
  }, timeoutMs)
  try {
    return await waitForSignal(controller.signal, task(controller.signal))
  } catch (error) {
    if (controller.signal.reason === OperationTimedOut) {
      throw transportError(operation, error, secretBoundary)
    }
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", aborted)
  }
}

/** Validates one opaque Kubernetes resourceVersion. */
function resourceVersion(value: unknown, operation: Operation): string {
  if (typeof value !== "string" || value.length === 0) throw protocolError(operation)
  return value
}

/** Reads one resource's required metadata fields. */
function resourceMetadata(
  value: unknown,
  operation: Operation,
  namespace: string,
  name: string
): string {
  const metadata = property(value, "metadata")
  if (property(metadata, "namespace") !== namespace || property(metadata, "name") !== name) {
    throw protocolError(operation)
  }
  return resourceVersion(property(metadata, "resourceVersion"), operation)
}

/** Strictly decodes one Kubernetes Secret data field as UTF-8. */
function secretText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw protocolError("get")
  }
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw protocolError("get")
  }
}

/** Parses an exact ConfigMap or Secret GET response. A missing key is absence, not a protocol failure. */
function parseResource(
  value: unknown,
  kind: Kind,
  namespace: string,
  name: string,
  key: string
): LoadedKey {
  if (property(value, "apiVersion") !== "v1" || property(value, "kind") !== kind) {
    throw protocolError("get")
  }
  const revision = resourceMetadata(value, "get", namespace, name)
  const data = property(value, "data")
  if (data === undefined) return Object.freeze({ missing: true, resourceVersion: revision })
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw protocolError("get")
  const encoded = property(data, key)
  if (encoded === undefined) return Object.freeze({ missing: true, resourceVersion: revision })
  if (kind === "Secret") {
    return Object.freeze({
      missing: false,
      text: secretText(encoded),
      resourceVersion: revision
    })
  }
  if (typeof encoded !== "string") throw protocolError("get")
  return Object.freeze({ missing: false, text: encoded, resourceVersion: revision })
}

/** Parses a field-selected Kubernetes list used only for reconciliation. */
function parseList(value: unknown, kind: Kind, namespace: string, name: string): ListedResource {
  if (property(value, "apiVersion") !== "v1" || property(value, "kind") !== `${kind}List`) {
    throw protocolError("list")
  }
  const revision = resourceVersion(property(property(value, "metadata"), "resourceVersion"), "list")
  const items = property(value, "items")
  if (!Array.isArray(items) || items.length > 1) throw protocolError("list")
  const item = items[0]
  if (item !== undefined) resourceMetadata(item, "list", namespace, name)
  return Object.freeze({ resourceVersion: revision, present: item !== undefined })
}

/** Parses one newline-delimited Kubernetes watch envelope. */
function parseWatchFrame(line: string, namespace: string, name: string): WatchOutcome {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    throw protocolError("watch")
  }
  const event = property(envelope, "type")
  const payload = property(envelope, "object")
  if (event === "ERROR") {
    if (property(payload, "kind") === "Status" && property(payload, "code") === 410) {
      return Object.freeze({ kind: "expired" })
    }
    throw protocolError("watch")
  }
  if (event === "BOOKMARK") {
    return Object.freeze({
      kind: "ended",
      resourceVersion: resourceVersion(
        property(property(payload, "metadata"), "resourceVersion"),
        "watch"
      )
    })
  }
  if (event === "ADDED" || event === "MODIFIED" || event === "DELETED") {
    return Object.freeze({
      kind: "changed",
      resourceVersion: resourceMetadata(payload, "watch", namespace, name)
    })
  }
  throw protocolError("watch")
}

/** Creates one key's ConfigSource. An absent object or key rejects unless optional is set. */
export function kubernetesSource(
  client: KubernetesClient,
  options: KubernetesSourceOptions
): ConfigSource {
  const connection = openKubernetesClient(client)
  if (options === null || typeof options !== "object") {
    throw new TypeError("Kubernetes options must be an object")
  }
  const namespaceInput = options.namespace
  const configMap = options.configMap
  const secret = options.secret
  const keyInput = options.key
  const sourceName = options.name ?? "kubernetes"
  const timeoutMs = options.timeoutMs ?? 10_000
  const watchTimeoutSeconds = options.watchTimeoutSeconds ?? 300
  const retryInitialMs = options.retryInitialMs ?? 250
  const retryMaximumMs = options.retryMaximumMs ?? Math.max(30_000, retryInitialMs)
  const decode = options.decode ?? jsonDecoder
  const optional = options.optional === true
  const fetch = connection.fetch
  const origin = connection.origin
  const token = connection.token
  const secretBoundary = token !== undefined
  const namespace = kubernetesNamespace(namespaceInput)
  let kind: Kind
  let resourceName: string
  if (configMap !== undefined && secret === undefined) {
    kind = "ConfigMap"
    resourceName = kubernetesResourceName(configMap)
  } else if (secret !== undefined && configMap === undefined) {
    kind = "Secret"
    resourceName = kubernetesResourceName(secret)
  } else {
    throw new TypeError("Kubernetes source must identify exactly one of configMap or secret")
  }
  const key = kubernetesKey(keyInput)
  if (typeof sourceName !== "string" || sourceName.length === 0) {
    throw new TypeError("Kubernetes source name must be non-empty")
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new TypeError("Kubernetes timeoutMs must be an integer from 1 through 600000")
  }
  if (
    !Number.isInteger(watchTimeoutSeconds) ||
    watchTimeoutSeconds < 1 ||
    watchTimeoutSeconds > 3600
  ) {
    throw new TypeError("Kubernetes watchTimeoutSeconds must be an integer from 1 through 3600")
  }
  if (!Number.isInteger(retryInitialMs) || retryInitialMs < 1 || retryInitialMs > 60_000) {
    throw new TypeError("Kubernetes retryInitialMs must be an integer from 1 through 60000")
  }
  if (
    !Number.isInteger(retryMaximumMs) ||
    retryMaximumMs < retryInitialMs ||
    retryMaximumMs > 600_000
  ) {
    throw new TypeError("Kubernetes retryMaximumMs must be from retryInitialMs through 600000")
  }
  if (typeof decode !== "function") throw new TypeError("Kubernetes decoder must be callable")

  const plural = kind === "ConfigMap" ? "configmaps" : "secrets"
  const collection = `/api/v1/namespaces/${encodeURIComponent(namespace)}/${plural}`
  const exact = `${collection}/${encodeURIComponent(resourceName)}`
  const identity = `${namespace}/${kind}/${resourceName}:${key}`

  /** Performs one status-authoritative Kubernetes API request. */
  async function request(
    operation: Operation,
    path: string,
    signal: AbortSignal | null
  ): Promise<Response> {
    const init: RequestInit = {
      headers: kubernetesHeaders(token, false),
      method: "GET",
      redirect: "error"
    }
    if (signal !== null) init.signal = signal
    let response: Response
    try {
      response = await waitForSignal(
        signal,
        Promise.resolve(fetch(new Request(new URL(path, origin), init)))
      )
    } catch (value) {
      if (signal !== null && signal.aborted) throw signal.reason
      throw transportError(operation, value, secretBoundary)
    }
    if (!response.ok) {
      discardBody(response)
      throw httpError(operation, response.status)
    }
    return response
  }

  /** Reads one successful JSON response without retaining malformed content. */
  async function responseJson(
    operation: Operation,
    response: Response,
    signal: AbortSignal | null
  ): Promise<unknown> {
    let pending: Promise<string>
    try {
      pending = Promise.resolve(response.text())
    } catch (value) {
      throw transportError(operation, value, secretBoundary)
    }
    let text: string
    try {
      text = await waitForSignal(signal, pending)
    } catch (value) {
      if (signal !== null && signal.aborted) throw signal.reason
      throw transportError(operation, value, secretBoundary)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw protocolError(operation)
    }
  }

  /** Loads the selected object and key at its exact resourceVersion. */
  async function get(signal: AbortSignal | null): Promise<LoadedKey> {
    return withOperationTimeout(
      signal,
      timeoutMs,
      "get",
      secretBoundary,
      async function timedGet(timedSignal) {
        try {
          const response = await request("get", exact, timedSignal)
          return parseResource(
            await responseJson("get", response, timedSignal),
            kind,
            namespace,
            resourceName,
            key
          )
        } catch (error) {
          if (missingObject(error)) return Object.freeze({ missing: true, resourceVersion: null })
          throw error
        }
      }
    )
  }

  /** Lists the selected object to obtain a fresh collection resourceVersion. */
  async function list(signal: AbortSignal | null): Promise<ListedResource> {
    return withOperationTimeout(
      signal,
      timeoutMs,
      "list",
      secretBoundary,
      async function timedList(timedSignal) {
        const query = new URLSearchParams({ fieldSelector: `metadata.name=${resourceName}` })
        const response = await request("list", `${collection}?${query}`, timedSignal)
        return parseList(
          await responseJson("list", response, timedSignal),
          kind,
          namespace,
          resourceName
        )
      }
    )
  }

  /** Watches until one mutation, cursor expiry, or clean server timeout. */
  async function watchOnce(signal: AbortSignal, candidate: string): Promise<WatchOutcome> {
    const query = new URLSearchParams({
      allowWatchBookmarks: "true",
      fieldSelector: `metadata.name=${resourceName}`,
      resourceVersion: candidate,
      timeoutSeconds: String(watchTimeoutSeconds),
      watch: "true"
    })
    const response = await withOperationTimeout(
      signal,
      timeoutMs,
      "watch",
      secretBoundary,
      function admitWatch(timedSignal): Promise<Response> {
        return request("watch", `${collection}?${query}`, timedSignal)
      }
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let current = candidate
    try {
      const body = response.body
      if (body === null) throw protocolError("watch")
      reader = body.getReader()
      const decoder = new TextDecoder("utf-8", { fatal: true })
      const encoder = new TextEncoder()
      let buffered = ""
      let bufferedBytes = 0
      while (true) {
        let chunk
        try {
          chunk = await waitForSignal(signal, reader.read())
        } catch (value) {
          if (signal.aborted) throw signal.reason
          throw transportError("watch", value, secretBoundary)
        }
        try {
          if (chunk.done) buffered += decoder.decode()
          else {
            bufferedBytes += chunk.value.byteLength
            buffered += decoder.decode(chunk.value, { stream: true })
          }
        } catch {
          throw protocolError("watch")
        }
        let newline = buffered.indexOf("\n")
        while (newline >= 0) {
          const rawLine = buffered.slice(0, newline)
          const consumed = encoder.encode(`${rawLine}\n`).byteLength
          if (consumed - 1 > MaximumWatchFrameBytes) {
            throw protocolError("watch")
          }
          bufferedBytes -= consumed
          const line = rawLine.trim()
          buffered = buffered.slice(newline + 1)
          if (line !== "") {
            const outcome = parseWatchFrame(line, namespace, resourceName)
            if (outcome.kind === "ended") current = outcome.resourceVersion
            else return outcome
          }
          newline = buffered.indexOf("\n")
        }
        if (bufferedBytes > MaximumWatchFrameBytes) throw protocolError("watch")
        if (chunk.done) {
          const line = buffered.trim()
          if (line !== "") {
            const outcome = parseWatchFrame(line, namespace, resourceName)
            if (outcome.kind !== "ended") return outcome
            current = outcome.resourceVersion
          }
          return Object.freeze({ kind: "ended", resourceVersion: current })
        }
      }
    } finally {
      if (reader !== null) {
        try {
          await settle(reader.cancel())
        } catch {
          // Reader cancellation may throw synchronously in a hostile Fetch implementation.
        }
        try {
          reader.releaseLock()
        } catch {
          // Lock release is best-effort after cancellation has settled.
        }
      }
    }
  }

  /** Creates one source-owned cursor that reconciles after gaps. */
  function createWatcher(candidate: string | null): ConfigSourceWatcher {
    let current = candidate
    let active: Promise<void> | null = null
    let waiting = false
    let stopped = false
    let shutdown: Promise<void> | null = null
    const controller = new AbortController()

    /** Runs streams until a resource mutation or required reconciliation is observable. */
    async function runNext(ctx: Context): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const callerSignal = ctx.done()
      const signal =
        callerSignal === null
          ? controller.signal
          : AbortSignal.any([callerSignal, controller.signal])
      let recovering = current === null
      let retryDelayMs = retryInitialMs
      try {
        while (true) {
          try {
            if (recovering) {
              const reconciled = await list(signal)
              current = reconciled.resourceVersion
              return
            }
            const cursor = current
            if (cursor === null) throw protocolError("watch")
            const outcome = await watchOnce(signal, cursor)
            if (outcome.kind === "changed") {
              current = outcome.resourceVersion
              return
            }
            if (outcome.kind === "expired") {
              const reconciled = await list(signal)
              current = reconciled.resourceVersion
              return
            }
            current = outcome.resourceVersion
            retryDelayMs = retryInitialMs
          } catch (error) {
            const failure = contextFailure(ctx)
            if (failure !== null) throw failure
            if (stopped) throw WatcherStopped
            if (configWatchExpired(error)) {
              const reconciled = await list(signal)
              current = reconciled.resourceVersion
              return
            }
            if (!retryableConfigFailure(error)) throw error
            recovering = true
            try {
              await waitForInterval(signal, retryDelayMs)
            } catch {
              const intervalFailure = contextFailure(ctx)
              if (intervalFailure !== null) throw intervalFailure
              throw WatcherStopped
            }
            retryDelayMs = Math.min(retryMaximumMs, retryDelayMs * 2)
          }
        }
      } finally {
        waiting = false
      }
    }

    return Object.freeze({
      /** Waits for one exact resource mutation or post-gap reconciliation. */
      next(ctx: Context): Promise<void> {
        if (stopped) return Promise.reject(WatcherStopped)
        if (waiting)
          return Promise.reject(new Error("Kubernetes configuration watcher is already waiting"))
        waiting = true
        const operation = runNext(ctx)
        active = settle(operation)
        return waitForContext(ctx, operation)
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

  /** Decodes one present document into a stable snapshot. */
  async function publishDocument(
    ctx: Context,
    text: string,
    revision: string
  ): Promise<ConfigSourceSnapshot> {
    let decoded: ConfigObject
    try {
      decoded = decode(text, identity)
    } catch {
      throw protocolError("get")
    }
    const stable = await objectSource(sourceName, decoded).load(ctx)
    const finalFailure = contextFailure(ctx)
    if (finalFailure !== null) throw finalFailure
    return Object.freeze({ value: stable.value, revision })
  }

  /** Publishes an absent optional document as an empty object at a real collection revision. */
  async function publishEmpty(ctx: Context, revision: string): Promise<ConfigSourceSnapshot> {
    const stable = await objectSource(sourceName, {}).load(ctx)
    const finalFailure = contextFailure(ctx)
    if (finalFailure !== null) throw finalFailure
    return Object.freeze({ value: stable.value, revision })
  }

  return Object.freeze({
    name: sourceName,
    /** Loads and snapshots one selected key from one exact Kubernetes resource. */
    async load(ctx: Context): Promise<ConfigSourceSnapshot> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      try {
        const result = await get(ctx.done())
        const queryFailure = contextFailure(ctx)
        if (queryFailure !== null) throw queryFailure
        if (!result.missing) return await publishDocument(ctx, result.text, result.resourceVersion)
        if (!optional) throw newConfigSourceMissingError(sourceName)
        let revision = result.resourceVersion
        if (revision === null) {
          const listed = await list(ctx.done())
          const listedFailure = contextFailure(ctx)
          if (listedFailure !== null) throw listedFailure
          if (listed.present) {
            const again = await get(ctx.done())
            const againFailure = contextFailure(ctx)
            if (againFailure !== null) throw againFailure
            if (!again.missing) return await publishDocument(ctx, again.text, again.resourceVersion)
            revision = again.resourceVersion ?? listed.resourceVersion
          } else {
            revision = listed.resourceVersion
          }
        }
        return await publishEmpty(ctx, revision)
      } catch (error) {
        throw contextFailure(ctx) ?? error
      }
    },
    /** Opens one exact-resource watch from the supplied resourceVersion. */
    watch(ctx: Context, candidate: string | null): Promise<ConfigSourceWatcher> {
      const failure = contextFailure(ctx)
      return failure === null ? Promise.resolve(createWatcher(candidate)) : Promise.reject(failure)
    }
  })
}
