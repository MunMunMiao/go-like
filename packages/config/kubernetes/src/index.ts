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

/** Executes one standard Web Fetch request without transferring Fetch ownership. */
export type KubernetesFetch = (request: Request) => Promise<Response>

/** Decodes one complete Kubernetes key into a configuration object. */
export type KubernetesDecoder = (text: string, identity: string) => ConfigObject

export type KubernetesConfigKind = "ConfigMap" | "Secret"

export interface KubernetesSourceOptions {
  readonly fetch: KubernetesFetch
  readonly address: string
  readonly namespace: string
  readonly kind: KubernetesConfigKind
  readonly name: string
  readonly key: string
  readonly sourceName?: string
  readonly token?: string
  readonly timeoutMs?: number
  readonly watchTimeoutSeconds?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Decodes complete key text; defaults to strict JSON object decoding. */
  readonly decode?: KubernetesDecoder
}

export interface KubernetesConfigHttpError extends Error {
  readonly name: "KubernetesConfigHttpError"
  readonly code: "GO_LIKE_KUBERNETES_CONFIG_HTTP"
  readonly operation: "get" | "list" | "watch"
  readonly status: number
}

export interface KubernetesConfigProtocolError extends Error {
  readonly name: "KubernetesConfigProtocolError"
  readonly code: "GO_LIKE_KUBERNETES_CONFIG_PROTOCOL"
  readonly operation: "get" | "list" | "watch"
}

export interface KubernetesConfigTransportError extends Error {
  readonly name: "KubernetesConfigTransportError"
  readonly code: "GO_LIKE_KUBERNETES_CONFIG_TRANSPORT"
  readonly operation: "get" | "list" | "watch"
}

type Operation = "get" | "list" | "watch"

interface ListedResource {
  readonly resourceVersion: string
}

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

const UnsafeKeys = new Set(["__proto__", "constructor", "prototype"])
const WatcherStopped = Object.freeze(new Error("Kubernetes configuration watcher has stopped"))
const OperationTimedOut = Object.freeze(new Error("Kubernetes configuration operation timed out"))
const MaximumWatchFrameBytes = 1_048_576
const NamespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/
const NamePattern =
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/
const KeyPattern = /^[A-Za-z0-9._-]+$/

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

/** Narrows validated JSON to a safe object root. */
function isJsonConfigObject(value: unknown): value is ConfigObject {
  return (
    value !== null && !Array.isArray(value) && typeof value === "object" && isJsonConfigValue(value)
  )
}

/** Decodes strict JSON whose root is a safe configuration object. */
export function jsonKubernetesDecoder(text: string, identity: string): ConfigObject {
  const value: unknown = JSON.parse(text)
  if (!isJsonConfigObject(value)) {
    throw new TypeError(`Kubernetes key "${identity}" must contain a JSON object`)
  }
  return value
}

/** Returns the caller's exact Context cancellation cause when terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Narrows one decorated Error to the public Kubernetes configuration HTTP shape. */
function isHttpError(error: Error): error is KubernetesConfigHttpError {
  return (
    error.name === "KubernetesConfigHttpError" &&
    "code" in error &&
    error.code === "GO_LIKE_KUBERNETES_CONFIG_HTTP" &&
    "operation" in error &&
    (error.operation === "get" || error.operation === "list" || error.operation === "watch") &&
    "status" in error &&
    typeof error.status === "number"
  )
}

/** Narrows one decorated Error to the public Kubernetes configuration protocol shape. */
function isProtocolError(error: Error): error is KubernetesConfigProtocolError {
  return (
    error.name === "KubernetesConfigProtocolError" &&
    "code" in error &&
    error.code === "GO_LIKE_KUBERNETES_CONFIG_PROTOCOL" &&
    "operation" in error &&
    (error.operation === "get" || error.operation === "list" || error.operation === "watch")
  )
}

/** Narrows one decorated Error to the public Kubernetes configuration transport shape. */
function isTransportError(error: Error): error is KubernetesConfigTransportError {
  return (
    error.name === "KubernetesConfigTransportError" &&
    "code" in error &&
    error.code === "GO_LIKE_KUBERNETES_CONFIG_TRANSPORT" &&
    "operation" in error &&
    (error.operation === "get" || error.operation === "list" || error.operation === "watch")
  )
}

/** Builds one public error without retaining response bodies or transport causes. */
function boundaryError(
  operation: Operation,
  kind: "http" | "protocol" | "transport",
  status?: number
): KubernetesConfigHttpError | KubernetesConfigProtocolError | KubernetesConfigTransportError {
  let error: Error
  if (kind === "http") {
    error = new Error(
      `Kubernetes configuration ${operation} request failed with HTTP ${status ?? 0}`
    )
    Object.defineProperties(error, {
      name: { value: "KubernetesConfigHttpError" },
      code: { value: "GO_LIKE_KUBERNETES_CONFIG_HTTP", enumerable: true },
      operation: { value: operation, enumerable: true },
      status: { value: status ?? 0, enumerable: true }
    })
    if (!isHttpError(error))
      throw new Error("Kubernetes configuration HTTP error construction failed")
    return Object.freeze(error)
  }
  if (kind === "transport") {
    error = new Error(`Kubernetes configuration ${operation} transport failed`)
    Object.defineProperties(error, {
      name: { value: "KubernetesConfigTransportError" },
      code: { value: "GO_LIKE_KUBERNETES_CONFIG_TRANSPORT", enumerable: true },
      operation: { value: operation, enumerable: true }
    })
    if (!isTransportError(error))
      throw new Error("Kubernetes configuration transport error construction failed")
    return Object.freeze(error)
  }
  error = new Error(`Kubernetes configuration ${operation} response was invalid`)
  Object.defineProperties(error, {
    name: { value: "KubernetesConfigProtocolError" },
    code: { value: "GO_LIKE_KUBERNETES_CONFIG_PROTOCOL", enumerable: true },
    operation: { value: operation, enumerable: true }
  })
  if (!isProtocolError(error))
    throw new Error("Kubernetes configuration protocol error construction failed")
  return Object.freeze(error)
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
      observedSignal.removeEventListener("abort", aborted)
      resolve(value)
    }
    /** Rejects and detaches the abort observer. */
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
      throw boundaryError(operation, "transport")
    }
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", aborted)
  }
}

/** Classifies only transport, overload, timeout, and server failures as retryable. */
function retryable(value: unknown): boolean {
  if (property(value, "code") === "GO_LIKE_KUBERNETES_CONFIG_TRANSPORT") return true
  if (property(value, "code") !== "GO_LIKE_KUBERNETES_CONFIG_HTTP") return false
  const status = property(value, "status")
  return (
    typeof status === "number" &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  )
}

/** Reports whether one watch cursor has expired. */
function expired(value: unknown): boolean {
  return (
    property(value, "code") === "GO_LIKE_KUBERNETES_CONFIG_HTTP" && property(value, "status") === 410
  )
}

/** Validates one opaque Kubernetes resourceVersion. */
function resourceVersion(value: unknown, operation: Operation): string {
  if (typeof value !== "string" || value.length === 0) throw boundaryError(operation, "protocol")
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
    throw boundaryError(operation, "protocol")
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
    throw boundaryError("get", "protocol")
  }
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw boundaryError("get", "protocol")
  }
}

/** Parses an exact ConfigMap or Secret GET response. */
function parseResource(
  value: unknown,
  kind: KubernetesConfigKind,
  namespace: string,
  name: string,
  key: string
): { readonly text: string; readonly resourceVersion: string } {
  if (property(value, "apiVersion") !== "v1" || property(value, "kind") !== kind) {
    throw boundaryError("get", "protocol")
  }
  const revision = resourceMetadata(value, "get", namespace, name)
  const encoded = property(property(value, "data"), key)
  let text: string
  if (kind === "Secret") text = secretText(encoded)
  else {
    if (typeof encoded !== "string") throw boundaryError("get", "protocol")
    text = encoded
  }
  return Object.freeze({ text, resourceVersion: revision })
}

/** Parses a field-selected Kubernetes list used only for reconciliation. */
function parseList(
  value: unknown,
  kind: KubernetesConfigKind,
  namespace: string,
  name: string
): ListedResource {
  if (property(value, "apiVersion") !== "v1" || property(value, "kind") !== `${kind}List`) {
    throw boundaryError("list", "protocol")
  }
  const revision = resourceVersion(property(property(value, "metadata"), "resourceVersion"), "list")
  const items = property(value, "items")
  if (!Array.isArray(items) || items.length > 1) throw boundaryError("list", "protocol")
  const item = items[0]
  if (item !== undefined) resourceMetadata(item, "list", namespace, name)
  return Object.freeze({ resourceVersion: revision })
}

/** Parses one newline-delimited Kubernetes watch envelope. */
function parseWatchFrame(line: string, namespace: string, name: string): WatchOutcome {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    throw boundaryError("watch", "protocol")
  }
  const event = property(envelope, "type")
  const payload = property(envelope, "object")
  if (event === "ERROR") {
    if (property(payload, "kind") === "Status" && property(payload, "code") === 410) {
      return Object.freeze({ kind: "expired" })
    }
    throw boundaryError("watch", "protocol")
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
  throw boundaryError("watch", "protocol")
}

/** Validates a bare HTTP(S) Kubernetes API origin. */
function apiOrigin(address: string): URL {
  let origin: URL
  try {
    origin = new URL(address)
  } catch {
    throw new TypeError("Kubernetes address must be a valid HTTP or HTTPS origin")
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError("Kubernetes address must use HTTP or HTTPS")
  }
  if (
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.pathname !== "" && origin.pathname !== "/") ||
    origin.href.includes("?") ||
    origin.href.includes("#")
  ) {
    throw new TypeError(
      "Kubernetes address must be an origin without credentials, path, query, or fragment"
    )
  }
  return origin
}

/** Validates a Bearer token at construction without reflecting its value. */
function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new TypeError("Kubernetes token must be a valid non-empty header value")
  }
  try {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${value}`)
  } catch {
    throw new TypeError("Kubernetes token must be a valid non-empty header value")
  }
  return value
}

/** Creates a single-resource Kubernetes ConfigSource over standard Fetch and streams. */
export function kubernetesSource(options: KubernetesSourceOptions): ConfigSource {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Kubernetes options must be an object")
  }
  const fetch = options.fetch
  const address = options.address
  const namespace = options.namespace
  const kind = options.kind
  const name = options.name
  const key = options.key
  const sourceName = options.sourceName ?? "kubernetes"
  const token = bearerToken(options.token)
  const timeoutMs = options.timeoutMs ?? 10_000
  const watchTimeoutSeconds = options.watchTimeoutSeconds ?? 300
  const retryInitialMs = options.retryInitialMs ?? 250
  const retryMaximumMs = options.retryMaximumMs ?? Math.max(30_000, retryInitialMs)
  const decode = options.decode ?? jsonKubernetesDecoder
  if (typeof fetch !== "function")
    throw new TypeError("Kubernetes Fetch capability must be callable")
  if (typeof address !== "string") throw new TypeError("Kubernetes address must be a string")
  const origin = apiOrigin(address)
  if (typeof namespace !== "string" || !NamespacePattern.test(namespace)) {
    throw new TypeError("Kubernetes namespace must be a DNS label")
  }
  if (kind !== "ConfigMap" && kind !== "Secret") {
    throw new TypeError("Kubernetes kind must be ConfigMap or Secret")
  }
  if (typeof name !== "string" || name.length > 253 || !NamePattern.test(name)) {
    throw new TypeError("Kubernetes resource name must be a DNS subdomain")
  }
  if (typeof key !== "string" || key.length > 253 || !KeyPattern.test(key)) {
    throw new TypeError(
      "Kubernetes key must contain only letters, digits, dot, underscore, or dash"
    )
  }
  if (typeof sourceName !== "string" || sourceName.length === 0) {
    throw new TypeError("Kubernetes sourceName must be non-empty")
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
  const exact = `${collection}/${encodeURIComponent(name)}`
  const identity = `${namespace}/${kind}/${name}:${key}`

  /** Performs one status-authoritative Kubernetes API request. */
  async function request(
    operation: Operation,
    path: string,
    signal: AbortSignal | null
  ): Promise<Response> {
    const headers = new Headers({ Accept: "application/json" })
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`)
    const init: RequestInit = { headers, method: "GET", redirect: "error" }
    if (signal !== null) init.signal = signal
    let response: Response
    try {
      response = await waitForSignal(
        signal,
        Promise.resolve(fetch(new Request(new URL(path, origin), init)))
      )
    } catch {
      if (signal !== null && signal.aborted) throw signal.reason
      throw boundaryError(operation, "transport")
    }
    if (!response.ok) {
      discardBody(response)
      throw boundaryError(operation, "http", response.status)
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
    } catch {
      throw boundaryError(operation, "transport")
    }
    let text: string
    try {
      text = await waitForSignal(signal, pending)
    } catch {
      if (signal !== null && signal.aborted) throw signal.reason
      throw boundaryError(operation, "transport")
    }
    try {
      return JSON.parse(text)
    } catch {
      throw boundaryError(operation, "protocol")
    }
  }

  /** Loads the selected object and key at its exact resourceVersion. */
  async function get(signal: AbortSignal | null): Promise<{
    readonly text: string
    readonly resourceVersion: string
  }> {
    return withOperationTimeout(signal, timeoutMs, "get", async function timedGet(timedSignal) {
      const response = await request("get", exact, timedSignal)
      return parseResource(
        await responseJson("get", response, timedSignal),
        kind,
        namespace,
        name,
        key
      )
    })
  }

  /** Lists the selected object to obtain a fresh collection resourceVersion. */
  async function list(signal: AbortSignal): Promise<ListedResource> {
    return withOperationTimeout(signal, timeoutMs, "list", async function timedList(timedSignal) {
      const query = new URLSearchParams({ fieldSelector: `metadata.name=${name}` })
      const response = await request("list", `${collection}?${query}`, timedSignal)
      return parseList(await responseJson("list", response, timedSignal), kind, namespace, name)
    })
  }

  /** Watches until one mutation, cursor expiry, or clean server timeout. */
  async function watchOnce(signal: AbortSignal, candidate: string): Promise<WatchOutcome> {
    const query = new URLSearchParams({
      allowWatchBookmarks: "true",
      fieldSelector: `metadata.name=${name}`,
      resourceVersion: candidate,
      timeoutSeconds: String(watchTimeoutSeconds),
      watch: "true"
    })
    const response = await withOperationTimeout(
      signal,
      timeoutMs,
      "watch",
      function admitWatch(timedSignal): Promise<Response> {
        return request("watch", `${collection}?${query}`, timedSignal)
      }
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let current = candidate
    try {
      const body = response.body
      if (body === null) throw boundaryError("watch", "protocol")
      reader = body.getReader()
      const decoder = new TextDecoder("utf-8", { fatal: true })
      const encoder = new TextEncoder()
      let buffered = ""
      let bufferedBytes = 0
      while (true) {
        let chunk
        try {
          chunk = await waitForSignal(signal, reader.read())
        } catch {
          if (signal.aborted) throw signal.reason
          throw boundaryError("watch", "transport")
        }
        try {
          if (chunk.done) buffered += decoder.decode()
          else {
            bufferedBytes += chunk.value.byteLength
            buffered += decoder.decode(chunk.value, { stream: true })
          }
        } catch {
          throw boundaryError("watch", "protocol")
        }
        let newline = buffered.indexOf("\n")
        while (newline >= 0) {
          const rawLine = buffered.slice(0, newline)
          const consumed = encoder.encode(`${rawLine}\n`).byteLength
          if (consumed - 1 > MaximumWatchFrameBytes) {
            throw boundaryError("watch", "protocol")
          }
          bufferedBytes -= consumed
          const line = rawLine.trim()
          buffered = buffered.slice(newline + 1)
          if (line !== "") {
            const outcome = parseWatchFrame(line, namespace, name)
            if (outcome.kind === "ended") current = outcome.resourceVersion
            else return outcome
          }
          newline = buffered.indexOf("\n")
        }
        if (bufferedBytes > MaximumWatchFrameBytes) throw boundaryError("watch", "protocol")
        if (chunk.done) {
          const line = buffered.trim()
          if (line !== "") {
            const outcome = parseWatchFrame(line, namespace, name)
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
            if (cursor === null) throw boundaryError("watch", "protocol")
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
            if (expired(error)) {
              const reconciled = await list(signal)
              current = reconciled.resourceVersion
              return
            }
            if (!retryable(error)) throw error
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
        let decoded: ConfigObject
        try {
          decoded = decode(result.text, identity)
        } catch {
          throw boundaryError("get", "protocol")
        }
        const stable = await objectSource(sourceName, decoded).load(ctx)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return Object.freeze({ value: stable.value, revision: result.resourceVersion })
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
