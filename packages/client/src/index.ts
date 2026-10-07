import {
  background,
  canceled,
  deadlineExceeded,
  withoutCancel,
  withValue,
  type Context
} from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import { fromClientContext, newMetadata, type Metadata } from "@go-like/metadata"
import {
  newRoundRobinSelector,
  newNoAvailableEndpointError,
  type Discovery,
  type Filter,
  type SelectionDone,
  type SelectionOutcome,
  type Selector,
  type ServiceInstance
} from "@go-like/registry"
import { snapshotServiceInstances } from "@go-like/registry/provider"
import {
  newCircuitBreaker,
  retry,
  type Backoff,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type RetryOptions,
  type RetryPredicate
} from "@go-like/resilience"
import type { Infer, Struct } from "@go-like/struct"
import {
  applyResponseObservers,
  endpoint as endpointContract,
  fromClientContext as fromTransportClientContext,
  isServiceError,
  newClientContext as newTransportClientContext,
  observeResponseBody,
  type Endpoint,
  type Client as TransportClient,
  type Handler,
  type Middleware,
  type ServerStream,
  type Transport,
  type TransportInfo
} from "@go-like/transport"
import { metadata as metadataHeader, timeout as timeoutHeader } from "@go-like/transport/headers"
import { decodeJsonBody, encodeJsonBody, jsonContentType } from "@go-like/transport/json"
import { defaultSSEMaxMessageBytes, eventStreamContentType } from "@go-like/transport/sse"
import {
  decodeServiceErrorResponse,
  encodeMetadataHeader,
  newTransportProtocolError
} from "@go-like/transport/provider"
import {
  closeWithTimeout,
  isCompletedCallFailure,
  isError,
  newCompletedCallFailure
} from "./cleanup"
import { newDiscoveryResolver, type DiscoveryResolver } from "./resolver"
import { openServerStream } from "./stream"

const metadataHeaderLower = metadataHeader.toLowerCase()
const timeoutHeaderLower = timeoutHeader.toLowerCase()
const fallbackTransportKind = "transport"
const transportKindPattern = /^[a-z0-9][a-z0-9+._-]*$/
const emptyMetadata = newMetadata()
const callTransportStateKey = Object.freeze({})
const callTransportStates = new WeakSet<object>()
const typedResponseValidatorKey = Object.freeze({})
const typedResponseValidators = new WeakSet<object>()
const committedExchanges = new WeakSet<object>()
const defaultClientOptions: ClientOptions = Object.freeze({
  addresses: Object.freeze([]),
  service: null,
  discovery: null,
  selector: null,
  transport: null,
  block: false,
  middleware: Object.freeze([]),
  operationMiddleware: new Map(),
  closeTimeoutMs: 1_000,
  poolSize: 100,
  poolTtlMs: 60_000
})
const defaultCallOptions: CallOptions = Object.freeze({
  filters: Object.freeze([]),
  retry: null
})
const publishedCallOptions = new WeakSet<object>([defaultCallOptions])
const maximumDirectSnapshots = 1_024

interface ClientOptionsCandidate {
  readonly addresses?: unknown
  readonly service?: unknown
  readonly discovery?: unknown
  readonly selector?: unknown
  readonly transport?: unknown
  readonly block?: unknown
  readonly middleware?: unknown
  readonly operationMiddleware?: unknown
  readonly closeTimeoutMs?: unknown
  readonly poolSize?: unknown
  readonly poolTtlMs?: unknown
}

interface DiscoverySource {
  readonly resolver: DiscoveryResolver
  readonly service: string
}

interface CallOptionsCandidate {
  readonly filters?: unknown
  readonly retry?: unknown
}

interface RetryOptionsCandidate {
  readonly authorization?: unknown
  readonly maxAttempts?: unknown
  readonly shouldRetry?: unknown
  readonly backoff?: unknown
}

interface CallTransportState {
  readonly beginAttempt: (target: string, requestHeaders: () => Metadata) => void
  readonly updateReply: (replyHeaders: () => Metadata) => void
}

interface TypedResponseValidator {
  readonly validate: (response: Response) => Promise<void>
}

interface CleanupRetryResult {
  readonly error: AggregateError
}

interface ResidentTransportClient {
  readonly address: string
  readonly receiver: TransportClient
  readonly fetch: TransportClient["fetch"]
  readonly close: TransportClient["close"]
  idleTimer: ReturnType<typeof setTimeout> | null
  closing: Promise<void> | null
}

const cleanupRetryResults = new WeakSet<object>()

/** Reports whether a value can carry one structural ClientOptions snapshot. */
function isClientOptionsCandidate(value: unknown): value is ClientOptionsCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reports whether a value can carry one structural CallOptions snapshot. */
function isCallOptionsCandidate(value: unknown): value is CallOptionsCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Recognizes the callable runtime shape of one retry predicate. */
function isRetryPredicate(value: unknown): value is RetryPredicate {
  return typeof value === "function"
}

/** Recognizes the callable runtime shape of one retry backoff. */
function isBackoff(value: unknown): value is Backoff {
  return typeof value === "function"
}

/** Reports whether a value is one URL-unreserved service or endpoint route token. */
function isRouteToken(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9._~-]+$/.test(value) && value !== "." && value !== ".."
  )
}

/** Validates one unambiguous service or endpoint token before any service I/O. */
function callName(value: unknown, field: string): string {
  if (!isRouteToken(value)) {
    throw new TypeError(`CallRequest.${field} must be a URL unreserved route token`)
  }
  return value
}

/** Validates one exact or trailing-wildcard operation selector. */
function operationSelector(value: unknown): string {
  const selector = callText(value, "client middleware selector", true)
  const wildcard = selector.indexOf("*")
  if (wildcard >= 0 && wildcard !== selector.length - 1) {
    throw new TypeError("client middleware selector must be exact or end with one *")
  }
  if (selector === "*") return selector
  const prefix = wildcard < 0 ? selector : selector.slice(0, -1)
  const separator = prefix.indexOf("/")
  const service = separator < 0 ? prefix : prefix.slice(0, separator)
  const endpoint = separator < 0 ? null : prefix.slice(separator + 1)
  const validEndpoint =
    endpoint === null || endpoint.length === 0 ? wildcard >= 0 : isRouteToken(endpoint)
  if (!isRouteToken(service) || !validEndpoint) {
    throw new TypeError(
      "client middleware selector must identify a canonical operation or trailing wildcard"
    )
  }
  return selector
}

/** Returns one comparable media type without optional parameters. */
function mediaType(value: string): string {
  return (value.split(";", 1)[0] ?? "").trim().toLowerCase()
}

/** Reads a transport receive ceiling, or the SSE default when the transport has none. */
function receiveLimit(transport: Transport): number {
  const method: unknown = Reflect.get(transport, "maxMessageBytes")
  if (typeof method !== "function") return defaultSSEMaxMessageBytes
  let selected: unknown
  try {
    selected = Reflect.apply(method, transport, [])
  } catch {
    return defaultSSEMaxMessageBytes
  }
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < 1) {
    return defaultSSEMaxMessageBytes
  }
  return selected
}

/** Validates one well-formed call option string without normalizing its bytes. */
function callText(value: unknown, field: string, nonEmpty: boolean): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || !value.isWellFormed()) {
    throw new TypeError(`${field} must be a${nonEmpty ? " non-empty" : ""} well-formed string`)
  }
  return value
}

/** Copies one duplicate-free address list without interpreting provider-specific bytes. */
function snapshotAddresses(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  const captured: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const address = callText(item, `${field} entry`, true)
    if (seen.has(address)) throw new TypeError(`${field} must not contain duplicate addresses`)
    seen.add(address)
    captured.push(address)
  }
  return Object.freeze(captured)
}

/** Preserves Error identity and normalizes non-Error boundary failures with their cause. */
function boundaryError(value: unknown): Error {
  return isError(value) ? value : new Error("client boundary rejected", { cause: value })
}

/** Creates one typed response validator whose result survives retry attempts. */
function newTypedResponseBoundary<ResponseSchema extends Struct>(
  schema: ResponseSchema
): readonly [
  validator: TypedResponseValidator,
  result: () => readonly [Infer<ResponseSchema>] | null,
  decode: (response: Response) => Promise<Infer<ResponseSchema>>
] {
  let result: readonly [Infer<ResponseSchema>] | null = null

  /** Decodes and captures the latest successful response attempt. */
  async function decode(response: Response): Promise<Infer<ResponseSchema>> {
    try {
      const value = response.headers.get("content-type")
      if (value === null || mediaType(value) !== jsonContentType) {
        throw new TypeError("unexpected response Content-Type")
      }
      const decoded = decodeJsonBody(schema, new Uint8Array(await response.arrayBuffer()))
      const captured: readonly [Infer<ResponseSchema>] = Object.freeze([decoded])
      result = captured
      return decoded
    } catch (value) {
      if (value === deadlineExceeded || value === canceled) throw value
      throw newTransportProtocolError("client typed response is invalid", boundaryError(value))
    }
  }

  /** Validates and captures one attempt for selector, retry, and middleware feedback. */
  async function validate(response: Response): Promise<void> {
    try {
      await decode(response)
    } catch (value) {
      abandonResponse(response)
      throw value
    }
  }

  /** Returns the latest captured response tuple without inventing a sentinel value. */
  function capturedResult(): readonly [Infer<ResponseSchema>] | null {
    return result
  }

  const validator = Object.freeze({ validate })
  typedResponseValidators.add(validator)
  return Object.freeze([validator, capturedResult, decode])
}

/** Creates the stable contract failure for an asynchronous Selector completion callback. */
function selectionFeedbackContractError(cause?: unknown): TypeError {
  return cause === undefined
    ? new TypeError("Selector.select completion callback must return void")
    : new TypeError("Selector.select completion callback must return void", { cause })
}

/** Consumes an out-of-contract asynchronous feedback settlement. */
function ignoreSelectionFeedbackSettlement(_value?: unknown): void {}

/** Detects and observes one forbidden completion thenable without awaiting it. */
function selectionFeedbackResult(value: unknown): Error | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null
  let then: unknown
  try {
    then = Reflect.get(value, "then")
  } catch (cause) {
    return selectionFeedbackContractError(cause)
  }
  if (typeof then !== "function") return null
  try {
    const continuation: unknown = Reflect.apply(then, value, [
      ignoreSelectionFeedbackSettlement,
      ignoreSelectionFeedbackSettlement
    ])
    if (continuation !== value) {
      void Promise.resolve(continuation).catch(ignoreSelectionFeedbackSettlement)
    }
  } catch (cause) {
    return selectionFeedbackContractError(cause)
  }
  return selectionFeedbackContractError()
}

/** Invokes one synchronous Selector completion and captures every feedback boundary failure. */
function publishSelectionFeedback(
  complete: SelectionDone,
  ctx: Context,
  selectionFailure: () => Error | null,
  bytesSent: boolean,
  bytesReceived: boolean,
  replyMetadata: (() => Metadata) | null
): Error | null {
  try {
    const feedbackContext = withoutCancel(ctx)
    const error = selectionFailure()
    const outcome: SelectionOutcome =
      replyMetadata === null
        ? Object.freeze({ error, bytesSent, bytesReceived })
        : Object.freeze({
            error,
            get replyMetadata(): Metadata {
              return replyMetadata()
            },
            bytesSent,
            bytesReceived
          })
    return selectionFeedbackResult(Reflect.apply(complete, undefined, [feedbackContext, outcome]))
  } catch (value) {
    return boundaryError(value)
  }
}

/** Converts one completed exchange failure into a retry fulfillment sentinel. */
function cleanupRetryResult(error: AggregateError): CleanupRetryResult {
  const result = Object.freeze({ error })
  cleanupRetryResults.add(result)
  return result
}

/** Recognizes the private fulfillment used to cross the resilience retry boundary. */
function isCleanupRetryResult(value: unknown): value is CleanupRetryResult {
  return typeof value === "object" && value !== null && cleanupRetryResults.has(value)
}

/** Reads one structural method without invoking an accessor. */
function dataMethod(value: object, key: string): unknown {
  let owner: object | null = value
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : null
    owner = Object.getPrototypeOf(owner)
  }
  return null
}

/** Captures an optional honest provider kind without consulting its diagnostic string. */
function transportKind(value: unknown): string {
  if (typeof value !== "object" || value === null) return fallbackTransportKind
  const candidate = dataMethod(value, "kind")
  if (typeof candidate !== "function") return fallbackTransportKind
  try {
    const kind: unknown = candidate.call(value)
    if (typeof kind === "string" && kind.length <= 64 && transportKindPattern.test(kind)) {
      return kind
    }
  } catch {
    // An optional observability capability cannot reject a business call.
  }
  return fallbackTransportKind
}

/** Rejects caller ownership of the metadata and deadline headers reserved by this Client. */
function rejectReservedHeaders(headers: Headers): void {
  for (const [name] of headers) {
    const lower = name.toLowerCase()
    if (lower === metadataHeaderLower || lower === timeoutHeaderLower) {
      throw new TypeError(`request header ${name} is reserved by @go-like/client`)
    }
  }
}

/** Copies caller headers before discovery so later mutation cannot change the exchange. */
function snapshotHeaders(headers: unknown): Headers {
  if (headers instanceof Headers) return new Headers(headers)
  if (Array.isArray(headers) || (typeof headers === "object" && headers !== null)) {
    try {
      return new Headers(headers as HeadersInit)
    } catch (value) {
      throw new TypeError("CallRequest.headers must be a header record", { cause: value })
    }
  }
  throw new TypeError("CallRequest.headers must be a header record")
}

/** Copies one replayable request body, or accepts null when the call has no body. */
function snapshotBody(body: unknown): Uint8Array<ArrayBuffer> | null {
  if (body === null) return null
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("CallRequest.body must be a Uint8Array or null")
  }
  return new Uint8Array(body)
}

/** Returns the remaining whole milliseconds, or null when the caller set no deadline. */
function timeoutHeaderValue(ctx: Context): string | null {
  const deadline = ctx.deadline()
  if (deadline[1] !== true) return null
  const remaining = deadline[0].getTime() - Date.now()
  if (remaining <= 0) return "0"
  const milliseconds = Math.ceil(remaining)
  if (!Number.isSafeInteger(milliseconds)) return null
  return String(milliseconds)
}

/** Rejects a selected node address that is not an absolute root URL. */
function assertRootAddress(address: string): void {
  let url: URL
  try {
    url = new URL(address)
  } catch (value) {
    throw new TypeError(`client node address must be an absolute root URL, received ${address}`, {
      cause: value
    })
  }
  if (
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.href.includes("#") ||
    url.href.includes("?")
  ) {
    throw new TypeError(`client node address must be an absolute root URL, received ${address}`)
  }
}

/** Builds the outbound headers for one attempt, including a freshly computed timeout. */
function outboundHeaders(headers: Headers, ctx: Context): Headers {
  const outbound = new Headers(headers)
  const encoded = encodeMetadataHeader(fromClientContext(ctx) ?? emptyMetadata)
  if (encoded !== null) outbound.set(metadataHeader, encoded)
  const timeoutMs = timeoutHeaderValue(ctx)
  if (timeoutMs !== null) outbound.set(timeoutHeader, timeoutMs)
  return outbound
}

/** Builds one replayable POST request for the selected node. */
function callRequest(
  address: string,
  service: string,
  endpoint: string,
  outbound: Headers,
  body: Uint8Array<ArrayBuffer> | null,
  ctx: Context
): Request {
  const timeoutMs = timeoutHeaderValue(ctx)
  if (timeoutMs !== null) outbound.set(timeoutHeader, timeoutMs)
  const init: RequestInit = { method: "POST", headers: outbound }
  if (body !== null) init.body = body
  return new Request(new URL(`/${service}/${endpoint}`, address), init)
}

/** Drops an unread response body without delaying the caller's protocol error. */
function abandonResponse(response: Response): void {
  if (response.body === null || response.bodyUsed) return
  void response.body.cancel().catch(function drain(): void {
    void response.arrayBuffer().catch(function ignored(): void {})
  })
}

/** Projects real wire entries in one pass without making Metadata validity a protocol gate. */
function wireHeaderMetadata(entries: readonly (readonly [string, string])[]): Metadata {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of entries) {
    if (key.length === 0 || !key.isWellFormed() || !value.isWellFormed()) continue
    const normalized = key.toLowerCase()
    const values = grouped.get(normalized)
    if (values === undefined) grouped.set(normalized, [value])
    else values.push(value)
  }
  return newMetadata(Object.fromEntries(grouped))
}

function emptyMetadataReader(): Metadata {
  return emptyMetadata
}

/** Defers header projection until observed; the entries are captured now. */
function lazyHeadersMetadata(headers: Headers): () => Metadata {
  let cached: Metadata | null = null
  return function readHeadersMetadata(): Metadata {
    cached ??= headersMetadata(headers)
    return cached
  }
}

/** Projects one Fetch header list to an immutable observable snapshot. */
function headersMetadata(headers: Headers): Metadata {
  const entries: (readonly [string, string])[] = []
  headers.forEach(function capture(value, key): void {
    entries.push([key, value])
  })
  return wireHeaderMetadata(entries)
}

/** Creates one call-scoped dynamic TransportInfo facade without making observation a call gate. */
function newCallTransportContext(
  ctx: Context,
  kind: string,
  operation: string
): readonly [Context, CallTransportState] {
  let target = ""
  let requestHeaders: () => Metadata = emptyMetadataReader
  let replyHeaders: () => Metadata = emptyMetadataReader
  const info: TransportInfo = {
    kind(): string {
      return kind
    },
    endpoint(): string {
      return target
    },
    operation(): string {
      return operation
    },
    requestHeaders(): Metadata {
      return requestHeaders()
    },
    replyHeaders(): Metadata {
      return replyHeaders()
    },
    peerIdentity(): string | null {
      return null
    }
  }
  const state: CallTransportState = Object.freeze({
    beginAttempt(nextTarget: string, nextRequestHeaders: () => Metadata): void {
      target = nextTarget
      requestHeaders = nextRequestHeaders
      replyHeaders = emptyMetadataReader
    },
    updateReply(nextReplyHeaders: () => Metadata): void {
      replyHeaders = nextReplyHeaders
    }
  })
  callTransportStates.add(state)
  let observed = ctx
  try {
    observed = newTransportClientContext(ctx, info)
  } catch {
    // Invalid optional observation fields cannot reject the underlying call.
  }
  return Object.freeze([withValue(observed, callTransportStateKey, state), state])
}

/** Reads the private mutable facade state inherited through one logical call Context. */
function callTransportState(ctx: Context): CallTransportState | null {
  const value = ctx.value(callTransportStateKey)
  return typeof value === "object" && value !== null && callTransportStates.has(value)
    ? (value as CallTransportState)
    : null
}

/** Reads the private typed response validator inherited through one logical call Context. */
function typedResponseValidator(ctx: Context): TypedResponseValidator | null {
  const value = ctx.value(typedResponseValidatorKey)
  return typeof value === "object" && value !== null && typedResponseValidators.has(value)
    ? (value as TypedResponseValidator)
    : null
}

/** Adds truthful pre-selection operation identity for Client middleware. */
function logicalTransportContext(ctx: Context, request: CallRequest, kind: string): Context {
  const service = callName(request?.service, "service")
  const endpoint = callName(request?.endpoint, "endpoint")
  return newCallTransportContext(ctx, kind, `${service}/${endpoint}`)[0]
}

/** Snapshots the only Selector result shape accepted before any target I/O. */
function snapshotSelection(value: unknown): readonly [string, SelectionDone] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Selector.select must return an endpoint and completion callback tuple")
  }
  const selected: unknown = value[0]
  const complete: unknown = value[1]
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
    throw new TypeError("Selector.select endpoint must be an object")
  }
  const url: unknown = Reflect.get(selected, "url")
  if (typeof url !== "string" || url.length === 0 || !url.isWellFormed()) {
    throw new TypeError("Selector.select endpoint url must be a non-empty well-formed string")
  }
  if (typeof complete !== "function") {
    throw new TypeError("Selector.select completion callback must be a function")
  }
  return Object.freeze([url, complete as SelectionDone])
}

/** Describes one unary service call carried by a Fetch request. */
export interface CallRequest {
  readonly service: string
  readonly endpoint: string
  readonly headers: HeadersInit
  readonly body: Uint8Array | null
}

/** Resolves and performs one unary internal service call at a time. */
export interface Client {
  /** Calls one typed endpoint while preserving the raw Fetch API. */
  call<Request extends Struct, ResponseSchema extends Struct>(
    ctx: Context,
    endpoint: Endpoint<Request, ResponseSchema>,
    request: NoInfer<Infer<Request>>,
    ...options: readonly CallOption[]
  ): Promise<Infer<ResponseSchema>>
  /** Discovers, selects, and exchanges one Fetch request under the caller Context. */
  call(ctx: Context, request: CallRequest, ...options: readonly CallOption[]): Promise<Response>
  /** Opens one server stream after the response headers arrive. */
  stream<Request extends Struct, ResponseSchema extends Struct>(
    ctx: Context,
    endpoint: Endpoint<Request, ResponseSchema, true>,
    request: NoInfer<Infer<Request>>,
    ...options: readonly CallOption[]
  ): Promise<ServerStream<Infer<ResponseSchema>>>
  /** Stops every resident transport connection and discovery watcher owned by this Client. */
  close(ctx: Context): Promise<void>
}

/** Captures the immutable routing and retry settings for one unary call. */
export interface CallOptions {
  /** Ordered go-micro-style filters applied before endpoint selection. */
  readonly filters: readonly Filter[]
  /** Explicit replay authorization and retry policy, or null for exactly one attempt. */
  readonly retry: RetryOptions | null
}

/** Immutably reduces options for one unary call. */
export type CallOption = (options: CallOptions) => CallOptions

/** Names the explicit replay authorization and bounded retry policy for one call. */
export type CallRetryOptions = RetryOptions

/** Performs one unary Client call. */
export type Call = Handler<CallRequest, Promise<Response>, readonly CallOption[]>

/** Wraps one unary Client call with explicit caller-owned behavior. */
export type ClientMiddleware = Middleware<CallRequest, Promise<Response>, readonly CallOption[]>

/** Captures the immutable construction settings used by one Client. */
export interface ClientOptions {
  readonly addresses: readonly string[]
  readonly service: string | null
  readonly discovery: Discovery | null
  readonly selector: Selector | null
  readonly transport: Transport | null
  /** Waits for the first raw discovery snapshot containing an endpoint when true. */
  readonly block?: boolean
  readonly middleware: readonly ClientMiddleware[]
  readonly operationMiddleware: ReadonlyMap<string, readonly ClientMiddleware[]>
  /** Maximum wait for each Transport Client close, or zero for an unbounded wait. */
  readonly closeTimeoutMs: number
  /** Maximum idle Transport owners retained across all addresses. */
  readonly poolSize?: number
  /** Maximum idle duration in milliseconds, or zero to disable time expiry. */
  readonly poolTtlMs?: number
}

/** Immutably reduces construction options for one Client. */
export type ClientOption = (options: ClientOptions) => ClientOptions

/** Validates one portable non-negative timeout. */
function timeoutInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new RangeError(`${field} must be an integer between 0 and 2147483647`)
  }
  return value
}

/** Reports whether a value provides the Discovery operation used by Client. */
function isDiscovery(value: unknown): value is Discovery {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "getService") === "function" &&
    typeof Reflect.get(value, "watch") === "function"
  )
}

/** Reports whether a value provides the Selector operation used by Client. */
function isSelector(value: unknown): value is Selector {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "select") === "function"
  )
}

/** Reports whether a value provides the Transport operation used by Client. */
function isTransport(value: unknown): value is Transport {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "dial") === "function"
  )
}

/** Reports whether a value is one Registry Filter callback. */
function isFilter(value: unknown): value is Filter {
  return typeof value === "function"
}

/** Reports whether a value is one call option function. */
function isCallOption(value: unknown): value is CallOption {
  return typeof value === "function"
}

/** Reports whether a value carries the raw call request shape. */
function isCallRequest(value: unknown): value is CallRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "service") === "string" &&
    typeof Reflect.get(value, "endpoint") === "string" &&
    "headers" in value &&
    "body" in value
  )
}

/** Reports whether a value carries one typed endpoint shape. */
function isEndpoint(value: unknown): value is Endpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "service") === "string" &&
    typeof Reflect.get(value, "endpoint") === "string" &&
    typeof Reflect.get(value, "request") === "object" &&
    typeof Reflect.get(value, "response") === "object"
  )
}

/** Copies and validates one complete ClientOptions snapshot. */
function snapshotClientOptions(value: unknown): ClientOptions {
  if (
    !isClientOptionsCandidate(value) ||
    !Array.isArray(value.middleware) ||
    !(value.operationMiddleware instanceof Map)
  ) {
    throw new TypeError("Client options must contain middleware collections")
  }
  const addresses = snapshotAddresses(value.addresses, "ClientOptions.addresses")
  const service =
    value.service === null ? null : callText(value.service, "ClientOptions.service", true)
  if (value.discovery !== null && !isDiscovery(value.discovery)) {
    throw new TypeError("Client discovery option must implement Discovery")
  }
  if (value.selector !== null && !isSelector(value.selector)) {
    throw new TypeError("Client selector option must implement Selector")
  }
  if (value.transport !== null && !isTransport(value.transport)) {
    throw new TypeError("Client transport option must implement Transport")
  }
  if (value.block !== undefined && typeof value.block !== "boolean") {
    throw new TypeError("Client block option must be a boolean")
  }
  const captured: ClientMiddleware[] = []
  for (const item of value.middleware) {
    if (typeof item !== "function") throw new TypeError("Client middleware must be a function")
    captured.push(item)
  }
  const operationMiddleware = new Map<string, readonly ClientMiddleware[]>()
  for (const [selector, values] of value.operationMiddleware) {
    const selected: ClientMiddleware[] = []
    if (!Array.isArray(values)) {
      throw new TypeError("Client operation middleware must be an array")
    }
    for (const item of values) {
      if (typeof item !== "function") throw new TypeError("Client middleware must be a function")
      selected.push(item)
    }
    operationMiddleware.set(operationSelector(selector), Object.freeze(selected))
  }
  return Object.freeze({
    addresses,
    service,
    discovery: value.discovery,
    selector: value.selector,
    transport: value.transport,
    block: value.block ?? false,
    middleware: Object.freeze(captured),
    operationMiddleware,
    closeTimeoutMs: timeoutInteger(value.closeTimeoutMs, "ClientOptions.closeTimeoutMs"),
    poolSize: timeoutInteger(value.poolSize ?? 100, "ClientOptions.poolSize"),
    poolTtlMs: timeoutInteger(value.poolTtlMs ?? 60_000, "ClientOptions.poolTtlMs")
  })
}

const discoveryScheme = /^discovery:/iu
const discoveryTripleSlash = /^discovery:\/\/\//iu

/** Parses one discovery:/// target and leaves every other scheme untouched. */
function discoveryTarget(value: string): string | null {
  if (!discoveryScheme.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new TypeError("withEndpoint discovery endpoint must be discovery:///name", { cause })
  }
  if (
    url.protocol !== "discovery:" ||
    url.host.length !== 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0
  ) {
    throw new TypeError("withEndpoint discovery authority must be empty")
  }
  if (
    !discoveryTripleSlash.test(value) ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    !url.pathname.startsWith("/")
  ) {
    throw new TypeError("withEndpoint discovery endpoint must be discovery:///name")
  }
  let target: string
  try {
    target = decodeURIComponent(url.pathname.slice(1))
  } catch (cause) {
    throw new TypeError("withEndpoint discovery endpoint must be discovery:///name", { cause })
  }
  if (target.length === 0) throw new TypeError("withEndpoint discovery target must be non-empty")
  return target
}

/** Resolves one withEndpoint argument into direct addresses or one discovery name. */
function endpointSource(value: unknown): {
  readonly addresses: readonly string[]
  readonly service: string | null
} {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new TypeError("withEndpoint requires at least one endpoint")
    const addresses = snapshotAddresses(value, "withEndpoint")
    for (const address of addresses) {
      if (discoveryScheme.test(address)) {
        throw new TypeError("withEndpoint arrays only accept direct addresses")
      }
    }
    return Object.freeze({ addresses, service: null })
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("withEndpoint requires a non-empty endpoint")
  }
  if (!value.isWellFormed()) throw new TypeError("withEndpoint endpoint must be well-formed")
  const service = discoveryTarget(value)
  return service === null
    ? Object.freeze({ addresses: Object.freeze([value]), service: null })
    : Object.freeze({ addresses: Object.freeze([]), service })
}

/** Configures one direct address list or one discovery:/// target. */
export function withEndpoint(endpoint: string | readonly string[]): ClientOption {
  const source = endpointSource(endpoint)
  return (options) =>
    snapshotClientOptions({
      addresses: source.addresses,
      service: source.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Configures the service Discovery used by future calls. */
export function withDiscovery(value: Discovery): ClientOption {
  if (!isDiscovery(value)) throw new TypeError("discovery must implement Discovery")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: value,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Waits for the first raw discovery snapshot containing an endpoint. */
export function withBlock(): ClientOption {
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: true,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Configures the endpoint Selector used by future calls. */
export function withSelector(value: Selector): ClientOption {
  if (!isSelector(value)) throw new TypeError("selector must implement Selector")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: value,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Configures the internal Transport used by future calls. */
export function withTransport(value: Transport): ClientOption {
  if (!isTransport(value)) throw new TypeError("transport must implement Transport")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: value,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Appends one ordinary function middleware to a future Client. */
export function middleware(value: ClientMiddleware): ClientOption {
  if (typeof value !== "function") throw new TypeError("Client middleware must be a function")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware.concat(value),
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Replaces middleware for one exact or trailing-wildcard operation selector. */
export function use(
  selector: string,
  ...values: readonly ClientMiddleware[] /* go-like-typed-rest: preserves ordered middleware. */
): ClientOption {
  const operation = operationSelector(selector)
  const selected: ClientMiddleware[] = []
  for (const value of values) {
    if (typeof value !== "function") throw new TypeError("Client middleware must be a function")
    selected.push(value)
  }

  /** Replaces the captured operation middleware sequence. */
  function applyUse(options: ClientOptions): ClientOptions {
    const operationMiddleware = new Map(options.operationMiddleware)
    operationMiddleware.set(operation, Object.freeze(selected))
    return snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
  }

  return applyUse
}

/**
 * Isolates consecutive-failure circuit breakers by the installed canonical service operation.
 */
export function circuitBreakerMiddleware(options: CircuitBreakerOptions): ClientMiddleware {
  if (options === null || typeof options !== "object") {
    throw new TypeError("circuit breaker options must be an object")
  }
  const isFailure = options.isFailure
  const captured: CircuitBreakerOptions =
    isFailure === undefined
      ? Object.freeze({
          failureThreshold: options.failureThreshold,
          resetTimeoutMs: options.resetTimeoutMs
        })
      : Object.freeze({
          failureThreshold: options.failureThreshold,
          resetTimeoutMs: options.resetTimeoutMs,
          isFailure
        })
  let first: CircuitBreaker | null = newCircuitBreaker(captured)
  const breakers = new Map<string, CircuitBreaker>()
  return (next) =>
    async (ctx, request, ...callOptions) => {
      const operation = fromTransportClientContext(ctx)?.operation() ?? ""
      if (operation.length === 0) return await next(ctx, request, ...callOptions)
      let breaker = breakers.get(operation)
      if (breaker === undefined) {
        breaker = first ?? newCircuitBreaker(captured)
        first = null
        breakers.set(operation, breaker)
      }
      const result = await breaker.execute<Response | CleanupRetryResult>(
        ctx,
        async (operationContext): Promise<Response | CleanupRetryResult> => {
          try {
            return await next(operationContext, request, ...callOptions)
          } catch (failure) {
            if (isCompletedCallFailure(failure)) return cleanupRetryResult(failure)
            throw failure
          }
        }
      )
      if (isCleanupRetryResult(result)) throw result.error
      return result
    }
}

/** Sets the maximum close wait in milliseconds, or zero to restore an unbounded wait. */
export function closeTimeout(timeoutMs: number): ClientOption {
  const captured = timeoutInteger(timeoutMs, "closeTimeout")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: captured,
      poolSize: options.poolSize,
      poolTtlMs: options.poolTtlMs
    })
}

/** Sets the maximum idle Transport owners retained across all addresses. */
export function poolSize(maxIdle: number): ClientOption {
  const captured = timeoutInteger(maxIdle, "poolSize")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: captured,
      poolTtlMs: options.poolTtlMs
    })
}

/** Sets the maximum idle duration in milliseconds, or zero to disable time expiry. */
export function poolTtl(milliseconds: number): ClientOption {
  const captured = timeoutInteger(milliseconds, "poolTtl")
  return (options) =>
    snapshotClientOptions({
      addresses: options.addresses,
      service: options.service,
      discovery: options.discovery,
      selector: options.selector,
      transport: options.transport,
      block: options.block,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      closeTimeoutMs: options.closeTimeoutMs,
      poolSize: options.poolSize,
      poolTtlMs: captured
    })
}

/** Applies and snapshots Client options in declaration order. */
function clientOptions(values: readonly ClientOption[]): ClientOptions {
  let current = defaultClientOptions
  for (const option of values) {
    if (typeof option !== "function") throw new TypeError("Client option must be a function")
    current = snapshotClientOptions(option(current))
  }
  return current
}

/** Copies one ordered Filter list without retaining a mutable option array. */
function snapshotFilters(value: unknown): readonly Filter[] {
  if (!Array.isArray(value)) throw new TypeError("CallOptions.filters must be an array")
  const captured: Filter[] = []
  for (const filter of value) {
    if (!isFilter(filter)) throw new TypeError("call filter must be a function")
    captured.push(filter)
  }
  return Object.freeze(captured)
}

/** Copies and validates one explicitly authorized resilience retry policy. */
function snapshotCallRetry(value: unknown): RetryOptions | null {
  if (value === null) return null
  if (!isCallOptionsCandidate(value)) {
    throw new TypeError("CallOptions.retry must be a retry options object or null")
  }
  const candidate: RetryOptionsCandidate = {
    authorization: Reflect.get(value, "authorization"),
    maxAttempts: Reflect.get(value, "maxAttempts"),
    shouldRetry: Reflect.get(value, "shouldRetry"),
    backoff: Reflect.get(value, "backoff")
  }
  const authorization = candidate.authorization
  const maxAttempts = candidate.maxAttempts
  const shouldRetry = candidate.shouldRetry
  const backoff = candidate.backoff
  if (authorization !== "idempotent" && authorization !== "caller-approved") {
    throw new TypeError("retry authorization must be idempotent or caller-approved")
  }
  if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("retry maxAttempts must be a positive safe integer")
  }
  if (!isRetryPredicate(shouldRetry)) {
    throw new TypeError("retry shouldRetry must be a function")
  }
  if (backoff !== undefined && !isBackoff(backoff)) {
    throw new TypeError("retry backoff must be a function")
  }
  if (backoff === undefined) {
    return Object.freeze({ authorization, maxAttempts, shouldRetry })
  }
  return Object.freeze({ authorization, maxAttempts, shouldRetry, backoff })
}

/** Prevents ownership-cleanup failures from replaying an already completed business exchange. */
function guardedCallRetry(options: RetryOptions): RetryOptions {
  const shouldRetry = options.shouldRetry
  const guarded: RetryPredicate = function shouldRetryCall(ctx, failure, attempt) {
    if (isCompletedCallFailure(failure)) return false
    if (typeof failure === "object" && failure !== null && committedExchanges.has(failure)) {
      return false
    }
    return shouldRetry(ctx, failure, attempt)
  }
  if (options.backoff === undefined) {
    return Object.freeze({
      authorization: options.authorization,
      maxAttempts: options.maxAttempts,
      shouldRetry: guarded
    })
  }
  return Object.freeze({
    authorization: options.authorization,
    maxAttempts: options.maxAttempts,
    shouldRetry: guarded,
    backoff: options.backoff
  })
}

/** Reports whether a value is a deeply frozen call-option snapshot published by this module. */
function isPublishedCallOptions(value: unknown): value is CallOptions {
  return typeof value === "object" && value !== null && publishedCallOptions.has(value)
}

/** Copies and validates one per-call option snapshot; a published snapshot is returned as is. */
function snapshotCallOptions(value: unknown): CallOptions {
  if (isPublishedCallOptions(value)) return value
  if (!isCallOptionsCandidate(value)) {
    throw new TypeError("Call options must be an object")
  }
  const snapshot: CallOptions = Object.freeze({
    filters: snapshotFilters(value.filters),
    retry: snapshotCallRetry(value.retry)
  })
  publishedCallOptions.add(snapshot)
  return snapshot
}

/** Appends go-micro-style Registry filters in declaration order. */
export function withFilter(...values: readonly Filter[]): CallOption {
  const captured: Filter[] = []
  for (const value of values) {
    if (!isFilter(value)) throw new TypeError("call filter must be a function")
    captured.push(value)
  }
  return (options) =>
    snapshotCallOptions({
      filters: options.filters.concat(captured),
      retry: options.retry
    })
}

/** Enables bounded retries only with explicit idempotent or caller-approved replay authorization. */
export function withRetry(options: CallRetryOptions): CallOption {
  const captured = snapshotCallRetry(options)
  return (current) =>
    snapshotCallOptions({
      filters: current.filters,
      retry: captured
    })
}

/** Applies and snapshots per-call options in declaration order. */
function callOptions(values: readonly CallOption[]): CallOptions {
  let current = defaultCallOptions
  for (const option of values) {
    if (typeof option !== "function") throw new TypeError("Call option must be a function")
    current = snapshotCallOptions(option(current))
  }
  return current
}

/** Filters one discovered snapshot by explicit call constraints without interpreting endpoints. */
function filteredInstances(
  instances: readonly ServiceInstance[],
  filters: readonly Filter[]
): readonly ServiceInstance[] {
  let filtered = instances
  for (const filter of filters) {
    const next = filter(filtered)
    if (!Array.isArray(next)) throw new TypeError("call filter must return ServiceInstance[]")
    if (next !== filtered) filtered = Object.freeze(Array.from(next))
  }
  if (filtered.length === 0) throw newNoAvailableEndpointError()
  return filtered
}

/** Creates the one immutable direct-address snapshot consumed by the shared Selector path. */
function directInstances(
  service: string,
  addresses: readonly string[]
): readonly ServiceInstance[] {
  return Object.freeze([
    Object.freeze({
      id: "",
      name: service,
      version: "",
      metadata: Object.freeze({}),
      endpoints: addresses
    })
  ])
}

/** Classifies one caller-visible primary error for selector health feedback. */
function selectionError(ctx: Context, primary: Error | null): Error | null {
  if (primary === null) return null
  if ("status" in primary && (primary.status === 503 || primary.status === 504)) return primary
  if (isServiceError(primary)) return null
  if (ctx.err() !== null) return null
  return primary
}

/** Creates one lightweight unary Client from one already resolved option snapshot. */
function createClient(
  source: DiscoverySource | null,
  selector: Selector,
  transport: Transport,
  config: ClientOptions
): Client {
  const select = selector.select
  const dial = transport.dial
  const kind = transportKind(transport)
  const closedError = new Error("client is closed")
  const idle = new Set<ResidentTransportClient>()
  const idleByAddress = new Map<string, ResidentTransportClient[]>()
  const active = new Set<ResidentTransportClient>()
  const connections = new Set<ResidentTransportClient>()
  const admissions = new Set<Promise<void>>()
  const maxIdle = config.poolSize ?? 100
  const idleTtlMs = config.poolTtlMs ?? 60_000
  let closed = false
  let transportClosing: Promise<void> | null = null
  let clientClosing: Promise<void> | null = null

  /** Cancels one idle expiry timer without changing transport ownership. */
  function clearIdleTimer(client: ResidentTransportClient): void {
    if (client.idleTimer === null) return
    clearTimeout(client.idleTimer)
    client.idleTimer = null
  }

  /** Closes one admitted transport owner exactly once. */
  function closeResident(client: ResidentTransportClient): Promise<void> {
    clearIdleTimer(client)
    if (client.closing !== null) return client.closing
    if (idle.delete(client)) {
      const owners = idleByAddress.get(client.address)
      const index = owners?.indexOf(client) ?? -1
      if (owners !== undefined && index >= 0) owners.splice(index, 1)
      if (owners?.length === 0) idleByAddress.delete(client.address)
    }
    active.delete(client)
    client.closing = Promise.resolve()
      .then(async function closeTransportOwner(): Promise<void> {
        await closeWithTimeout(client.receiver, client.close, config.closeTimeoutMs)
      })
      .finally(function forgetTransportOwner(): void {
        connections.delete(client)
      })
    void client.closing.catch(function observeTransportCloseFailure(): void {})
    return client.closing
  }

  /** Starts one standard idle expiry timer for the current Map generation. */
  function armIdleTimer(client: ResidentTransportClient): void {
    if (idleTtlMs === 0) return
    const timer = setTimeout(function expireIdleOwner(): void {
      if (client.idleTimer !== timer || !idle.has(client)) return
      client.idleTimer = null
      void closeResident(client)
    }, idleTtlMs)
    client.idleTimer = timer
  }

  /** Borrows one idle endpoint owner or dials and captures a new one. */
  async function acquire(ctx: Context, address: string): Promise<ResidentTransportClient> {
    if (closed) throw closedError
    const owners = idleByAddress.get(address)
    const available = owners?.pop()
    if (available !== undefined) {
      if (owners?.length === 0) idleByAddress.delete(address)
      idle.delete(available)
      clearIdleTimer(available)
      active.add(available)
      return available
    }

    const gate = Promise.withResolvers<void>()
    admissions.add(gate.promise)
    void gate.promise.catch(function observeAdmissionCleanupFailure(): void {})
    let admissionCleanupFailure: Error | null = null
    try {
      const admitted = await dial.call(transport, ctx, address)
      const admittedClose = admitted?.close
      if (typeof admittedClose !== "function") {
        throw new TypeError("transport dial must return a Client with fetch and close")
      }
      let admittedFetch: unknown
      try {
        admittedFetch = admitted.fetch
        if (typeof admittedFetch !== "function") {
          throw new TypeError("transport dial must return a Client with fetch and close")
        }
      } catch (value) {
        const primary = boundaryError(value)
        try {
          await closeWithTimeout(admitted, admittedClose, config.closeTimeoutMs)
        } catch (cleanupFailure) {
          throw new AggregateError(
            [primary, boundaryError(cleanupFailure)],
            "transport admission and cleanup failed"
          )
        }
        throw primary
      }
      const client: ResidentTransportClient = {
        address,
        receiver: admitted,
        fetch: admittedFetch as TransportClient["fetch"],
        close: admittedClose,
        idleTimer: null,
        closing: null
      }
      connections.add(client)
      if (closed) {
        try {
          await closeResident(client)
        } catch (value) {
          admissionCleanupFailure = boundaryError(value)
          throw new AggregateError(
            [closedError, admissionCleanupFailure],
            "client closed during transport admission and cleanup failed"
          )
        }
        throw closedError
      }
      active.add(client)
      return client
    } finally {
      admissions.delete(gate.promise)
      if (admissionCleanupFailure === null) gate.resolve()
      else gate.reject(admissionCleanupFailure)
    }
  }

  /** Returns only a completed exchange to the bounded idle set; every other owner is closed. */
  async function release(
    client: ResidentTransportClient,
    reusable: boolean
  ): Promise<Error | null> {
    active.delete(client)
    if (reusable && !closed && maxIdle > 0 && client.closing === null) {
      idle.add(client)
      const owners = idleByAddress.get(client.address)
      if (owners === undefined) idleByAddress.set(client.address, [client])
      else owners.push(client)
      armIdleTimer(client)
      while (idle.size > maxIdle) {
        const oldest = idle.values().next().value
        if (oldest === undefined) break
        void closeResident(oldest)
      }
      return null
    }
    try {
      await closeResident(client)
      return null
    } catch (value) {
      return boundaryError(value)
    }
  }

  /** Starts the transport-owner drain independently of any close caller. */
  function beginTransportClose(): Promise<void> {
    if (transportClosing !== null) return transportClosing
    closed = true
    const closing = Array.from(connections, closeResident)
    const pendingAdmissions = Array.from(admissions)
    transportClosing = (async function drainTransportOwners(): Promise<void> {
      const settled = await Promise.allSettled(closing.concat(pendingAdmissions))
      const failures: unknown[] = []
      for (const result of settled) {
        if (result.status === "rejected") failures.push(result.reason)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, "client transport cleanup failed")
      }
    })()
    void transportClosing.catch(function observeTransportDrainFailure(): void {})
    return transportClosing
  }

  /** Composes one Client call through an ordered middleware sequence. */
  function composeCall(handle: Call, values: readonly ClientMiddleware[]): Call {
    let composed = handle
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const wrapper = values[index]
      if (wrapper === undefined) continue
      const candidate = wrapper(composed)
      if (typeof candidate !== "function") {
        throw new TypeError("Client middleware must return a Call function")
      }
      composed = candidate
    }
    return composed
  }

  /** Selects one exact call or the longest matching trailing-wildcard call. */
  function operationCall(operation: string, values: ReadonlyMap<string, Call>): Call | null {
    const exact = values.get(operation)
    if (exact !== undefined) return exact
    let selected: Call | null = null
    let selectedLength = -1
    for (const [selector, call] of values) {
      if (!selector.endsWith("*")) continue
      const prefix = selector.slice(0, -1)
      if (prefix.length <= selectedLength || !operation.startsWith(prefix)) continue
      selected = call
      selectedLength = prefix.length
    }
    return selected
  }

  const directSnapshots = new Map<string, readonly ServiceInstance[]>()

  /** Returns one service's cached direct snapshot, or its configured form when unpublishable. */
  function directSnapshot(service: string): readonly ServiceInstance[] {
    const cached = directSnapshots.get(service)
    if (cached !== undefined) return cached
    const configured = directInstances(service, config.addresses)
    let snapshot: readonly ServiceInstance[]
    try {
      snapshot = snapshotServiceInstances(configured)
    } catch {
      // The Selector still rejects an unpublishable address exactly as before.
      snapshot = configured
    }
    if (directSnapshots.size >= maximumDirectSnapshots) directSnapshots.clear()
    directSnapshots.set(service, snapshot)
    return snapshot
  }

  /** Performs one selected dial and fetch attempt with exact cleanup ownership. */
  async function attempt(
    ctx: Context,
    service: string,
    endpoint: string,
    headers: Headers,
    body: Uint8Array<ArrayBuffer> | null,
    options: CallOptions
  ): Promise<Response> {
    const operation = `${service}/${endpoint}`
    const streaming = mediaType(headers.get("accept") ?? "") === eventStreamContentType
    /** Keeps a post-handshake stream failure from being replayed. */
    function commitExchange(error: Error): Error {
      if (streaming && bytesReceived) committedExchanges.add(error)
      return error
    }
    let complete: SelectionDone | null = null
    let transportClient: ResidentTransportClient | null = null
    let primary: Error | null = null
    let response: Response | null = null
    let bytesSent = false
    let bytesReceived = false
    let replyMetadata: (() => Metadata) | null = null
    try {
      let snapshot: readonly ServiceInstance[]
      if (source === null) snapshot = directSnapshot(service)
      else snapshot = await source.resolver.getService(ctx, source.service, config.block === true)
      const instances = filteredInstances(snapshot, options.filters)
      const selection = snapshotSelection(select.call(selector, ctx, instances))
      complete = selection[1]
      const address = selection[0]
      assertRootAddress(address)
      let attemptContext = ctx
      let projected = callTransportState(ctx)
      if (projected === null) {
        const created = newCallTransportContext(ctx, kind, operation)
        attemptContext = created[0]
        projected = created[1]
      }
      const outbound = outboundHeaders(headers, attemptContext)
      projected.beginAttempt(address, lazyHeadersMetadata(new Headers(outbound)))
      transportClient = await acquire(attemptContext, address)
      const request = callRequest(address, service, endpoint, outbound, body, attemptContext)
      projected.beginAttempt(address, lazyHeadersMetadata(outbound))
      bytesSent = true
      const candidate = await transportClient.fetch.call(
        transportClient.receiver,
        attemptContext,
        request
      )
      if (!(candidate instanceof Response)) {
        throw new TypeError("transport fetch must return a Response")
      }
      bytesReceived = true
      replyMetadata = lazyHeadersMetadata(new Headers(candidate.headers))
      projected.updateReply(replyMetadata)
      if (!candidate.ok) {
        const serviceFailure = await decodeServiceErrorResponse(candidate)
        if (serviceFailure !== null) throw serviceFailure
        abandonResponse(candidate)
        throw newTransportProtocolError(`client received HTTP status ${candidate.status}`)
      }
      if (streaming) {
        const deliveredType = mediaType(candidate.headers.get("content-type") ?? "")
        if (deliveredType !== eventStreamContentType) {
          abandonResponse(candidate)
          throw newTransportProtocolError(
            "server stream response Content-Type must be text/event-stream"
          )
        }
      }
      let delivered = applyResponseObservers(attemptContext, candidate)
      const validator = typedResponseValidator(attemptContext)
      const rawBody = validator === null && delivered.body !== null && delivered.bodyUsed !== true
      if (transportClient !== null && (streaming || rawBody)) {
        const held = transportClient
        delivered = observeResponseBody(
          delivered,
          function releaseHeld(): void {
            /** The body has already ended; pool release must not surface later. */
            function ignoreRelease(_value?: unknown): void {}
            void release(held, true).then(ignoreRelease, ignoreRelease)
          },
          { cancelSource: true }
        )
        // The body owns the owner only once observation started; a throw leaves it to `finally`.
        transportClient = null
      }
      response = delivered
      if (streaming) return delivered
      if (validator !== null) await validator.validate(delivered)
      return delivered
    } catch (value) {
      primary = commitExchange(boundaryError(value))
      throw primary
    } finally {
      let feedbackFailure: Error | null = null
      if (complete !== null) {
        feedbackFailure = publishSelectionFeedback(
          complete,
          ctx,
          function classifyUnarySelection(): Error | null {
            return selectionError(ctx, primary)
          },
          bytesSent,
          bytesReceived,
          replyMetadata
        )
      }

      const closeFailure =
        transportClient === null
          ? null
          : await release(transportClient, primary === null && response !== null)

      if (primary !== null && feedbackFailure !== null) {
        if (closeFailure !== null) {
          // oxlint-disable-next-line eslint/no-unsafe-finally -- Preserve primary/feedback/close order.
          throw commitExchange(
            new AggregateError(
              [primary, feedbackFailure, closeFailure],
              "client call and cleanup failed"
            )
          )
        }
        // oxlint-disable-next-line eslint/no-unsafe-finally -- Preserve primary/feedback order.
        throw commitExchange(
          new AggregateError([primary, feedbackFailure], "client call and feedback failed")
        )
      }
      if (primary !== null && closeFailure !== null) {
        // oxlint-disable-next-line eslint/no-unsafe-finally -- Preserve primary/close order.
        throw commitExchange(
          new AggregateError([primary, closeFailure], "client call and close failed")
        )
      }
      if (primary === null && response !== null) {
        const failures: Error[] = []
        if (feedbackFailure !== null) failures.push(feedbackFailure)
        if (closeFailure !== null) failures.push(closeFailure)
        if (failures.length !== 0) {
          // oxlint-disable-next-line eslint/no-unsafe-finally -- Return the completed reply with cleanup failures.
          throw newCompletedCallFailure(response, failures)
        }
      }
    }
  }

  /** Snapshots one logical call and performs one attempt unless replay was explicitly authorized. */
  const baseCall: Call = async function baseCall(ctx, request, ...values): Promise<Response> {
    const service = callName(request.service, "service")
    const endpoint = callName(request.endpoint, "endpoint")
    if (closed) throw closedError
    const headers = snapshotHeaders(request.headers)
    const body = snapshotBody(request.body)
    rejectReservedHeaders(headers)
    const options = callOptions(values)
    if (options.retry === null) {
      return await attempt(ctx, service, endpoint, headers, body, options)
    }
    const retried = await retry<Response | CleanupRetryResult>(
      ctx,
      async function retryAttempt(attemptContext): Promise<Response | CleanupRetryResult> {
        try {
          return await attempt(attemptContext, service, endpoint, headers, body, options)
        } catch (value) {
          if (isCompletedCallFailure(value)) {
            return cleanupRetryResult(value)
          }
          throw value
        }
      },
      guardedCallRetry(options.retry)
    )
    if (isCleanupRetryResult(retried)) throw retried.error
    return retried
  }

  const operationCalls = new Map<string, Call>()
  for (const [selector, values] of config.operationMiddleware) {
    operationCalls.set(selector, composeCall(baseCall, values))
  }

  /** Dispatches through one selected operation middleware sequence. */
  async function dispatch(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Response> {
    const operation = `${callName(request.service, "service")}/${callName(
      request.endpoint,
      "endpoint"
    )}`
    return await (operationCall(operation, operationCalls) ?? baseCall)(
      ctx,
      request,
      ...options /* go-like-typed-spread: forwards call options. */
    )
  }

  const composedCall = composeCall(dispatch, config.middleware)

  /** Converts one runtime argument suffix into validated call options. */
  function runtimeCallOptions(values: readonly unknown[], start: number): readonly CallOption[] {
    const selected: CallOption[] = []
    for (let index = start; index < values.length; index += 1) {
      const option = values[index]
      if (!isCallOption(option)) throw new TypeError("Client call option must be a function")
      selected.push(option)
    }
    return selected
  }

  /** Delegates one raw request through the immutable middleware composition. */
  async function rawCall(
    ctx: Context,
    request: CallRequest,
    options: readonly CallOption[]
  ): Promise<Response> {
    const resolved = callOptions(options)
    const logicalContext = logicalTransportContext(ctx, request, kind)
    return await composedCall(logicalContext, request, function resolvedCallOptions(): CallOptions {
      return resolved
    })
  }

  /** Calls one typed endpoint contract. */
  function call<RequestSchema extends Struct, ResponseSchema extends Struct>(
    ctx: Context,
    contract: Endpoint<RequestSchema, ResponseSchema>,
    request: NoInfer<Infer<RequestSchema>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Infer<ResponseSchema>>

  /** Calls one raw Fetch endpoint. */
  function call(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Response>

  /** Dispatches one raw or typed invocation without exposing an additional client concept. */
  async function call(
    ctx: Context,
    subject: unknown,
    ...values: readonly unknown[] /* go-like-typed-rest: accepts either public overload. */
  ): Promise<unknown> {
    if (closed) throw closedError
    if (isCallRequest(subject)) {
      return await rawCall(ctx, subject, runtimeCallOptions(values, 0))
    }
    if (!isEndpoint(subject)) throw new TypeError("Client call requires a request or Endpoint")
    if (subject.stream === true) {
      throw new TypeError("Client call does not accept a stream endpoint")
    }
    if (values.length === 0) throw new TypeError("Client typed call requires a request value")

    const contract = endpointContract(
      subject.service,
      subject.endpoint,
      subject.request,
      subject.response
    )
    const options = runtimeCallOptions(values, 1)
    const resolved = callOptions(options)
    const body = encodeJsonBody(contract.request, values[0])
    const request: CallRequest = {
      service: contract.service,
      endpoint: contract.endpoint,
      headers: { "content-type": jsonContentType },
      body
    }
    const boundary = newTypedResponseBoundary(contract.response)
    const response = await rawCall(
      withValue(ctx, typedResponseValidatorKey, boundary[0]),
      request,
      [
        function resolvedTypedCallOptions(): CallOptions {
          return resolved
        }
      ]
    )
    const decoded = boundary[1]()
    return decoded === null ? await boundary[2](response) : decoded[0]
  }

  /** Opens one server stream after response headers, then parses SSE on iteration. */
  async function stream<RequestSchema extends Struct, ResponseSchema extends Struct>(
    ctx: Context,
    subject: Endpoint<RequestSchema, ResponseSchema, true>,
    request: NoInfer<Infer<RequestSchema>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<ServerStream<Infer<ResponseSchema>>> {
    if (closed) throw closedError
    if (!isEndpoint(subject) || subject.stream !== true) {
      throw new TypeError("Client stream requires a stream endpoint")
    }
    const contract = endpointContract(
      subject.service,
      subject.endpoint,
      subject.request,
      subject.response,
      true
    )
    const body = encodeJsonBody(contract.request, request)
    const response = await rawCall(
      ctx,
      {
        service: contract.service,
        endpoint: contract.endpoint,
        headers: { "content-type": jsonContentType, accept: eventStreamContentType },
        body
      },
      options
    )
    return openServerStream(response, contract.response, receiveLimit(transport), ctx)
  }

  /** Starts the single combined transport and discovery owner drain. */
  function beginClientClose(): Promise<void> {
    if (clientClosing !== null) return clientClosing
    const operations: Promise<void>[] = [beginTransportClose()]
    if (source !== null) operations.push(source.resolver.close(background()))
    clientClosing = (async function drainClientOwners(): Promise<void> {
      const settled = await Promise.allSettled(operations)
      const failures: unknown[] = []
      for (const result of settled) {
        if (result.status === "rejected") failures.push(result.reason)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "client cleanup failed")
    })()
    void clientClosing.catch(function observeClientDrainFailure(): void {})
    return clientClosing
  }

  /** Closes resident transport owners and the resolver while bounding only this caller's wait. */
  function close(ctx: Context): Promise<void> {
    return waitForContext(ctx, beginClientClose())
  }

  return Object.freeze({ call, stream, close })
}

/** Creates one lightweight Client from go-micro-style functional options. */
export function newClient(...options: readonly ClientOption[]): Client {
  const resolved = clientOptions(options)
  if (resolved.transport === null) throw new TypeError("newClient requires a transport option")
  if (resolved.addresses.length > 0 && resolved.discovery !== null) {
    throw new TypeError("newClient cannot combine direct addresses with discovery")
  }
  let source: DiscoverySource | null
  if (resolved.discovery !== null) {
    if (resolved.service === null) {
      throw new TypeError(
        "newClient requires a discovery endpoint when withDiscovery is configured"
      )
    }
    source = {
      resolver: newDiscoveryResolver(resolved.discovery),
      service: resolved.service
    }
  } else {
    if (resolved.service !== null) {
      throw new TypeError("newClient discovery endpoint requires withDiscovery")
    }
    if (resolved.addresses.length === 0) {
      throw new TypeError("newClient requires direct addresses or discovery")
    }
    source = null
  }
  const selector = resolved.selector ?? newRoundRobinSelector()
  return createClient(source, selector, resolved.transport, resolved)
}
