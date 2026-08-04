import { background, withoutCancel, withValue, type Context } from "@go-like/context"
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
  endpoint as endpointContract,
  fromClientContext as fromTransportClientContext,
  isServiceError,
  newClientContext as newTransportClientContext,
  type Endpoint,
  type Client as TransportClient,
  type Handler,
  type Message,
  type Middleware,
  type Transport,
  type TransportInfo
} from "@go-like/transport"
import {
  endpoint as endpointHeader,
  contentType as contentTypeHeader,
  metadata as metadataHeader,
  request as serviceHeader
} from "@go-like/transport/headers"
import { decodeJsonBody, encodeJsonBody, jsonContentType } from "@go-like/transport/json"
import {
  decodeServiceError,
  encodeMetadataHeader,
  newTransportProtocolError,
  snapshotMessage
} from "@go-like/transport/provider"
import {
  closeWithTimeout,
  isCompletedCallFailure,
  isError,
  newCompletedCallFailure
} from "./cleanup"
import { newDiscoveryResolver } from "./resolver"

const serviceHeaderLower = serviceHeader.toLowerCase()
const endpointHeaderLower = endpointHeader.toLowerCase()
const metadataHeaderLower = metadataHeader.toLowerCase()
const fallbackTransportKind = "transport"
const transportKindPattern = /^[a-z0-9][a-z0-9+._-]*$/
const emptyMetadata = newMetadata()
const callTransportStateKey = Object.freeze({})
const callTransportStates = new WeakSet<object>()
const typedResponseValidatorKey = Object.freeze({})
const typedResponseValidators = new WeakSet<object>()
const defaultClientOptions: ClientOptions = Object.freeze({
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
  address: null,
  filters: Object.freeze([]),
  retry: null
})

interface ClientOptionsCandidate {
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

interface CallOptionsCandidate {
  readonly address?: unknown
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
  readonly beginAttempt: (target: string, requestHeaders: Metadata) => void
  readonly updateReply: (replyHeaders: Metadata) => void
}

interface TypedResponseValidator {
  readonly validate: (message: Message) => Promise<void>
}

interface CleanupRetryResult {
  readonly error: AggregateError
}

interface ResidentTransportClient {
  readonly address: string
  readonly receiver: TransportClient
  readonly send: TransportClient["send"]
  readonly recv: TransportClient["recv"]
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

/** Returns whether a string contains only complete UTF-16 scalar sequences. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Reports whether a value is one canonical service or endpoint route token. */
function isRouteToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]+$/u.test(value) && !/[/*]/u.test(value)
}

/** Validates one unambiguous service or endpoint token before any service I/O. */
function callName(value: unknown, field: string): string {
  if (!isRouteToken(value)) {
    throw new TypeError(`CallRequest.${field} must be a visible ASCII route token`)
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

/** Reads one case-insensitive Content-Type header and rejects duplicates. */
function messageContentType(header: Readonly<Record<string, string>>): string | null {
  let found: string | null = null
  for (const key of Object.keys(header)) {
    if (key.toLowerCase() !== contentTypeHeader.toLowerCase()) continue
    if (found !== null) throw new TypeError("duplicate Content-Type header")
    found = header[key] ?? ""
  }
  return found
}

/** Returns one comparable media type without optional parameters. */
function mediaType(value: string): string {
  return (value.split(";", 1)[0] ?? "").trim().toLowerCase()
}

/** Validates one well-formed call option string without normalizing its bytes. */
function callText(value: unknown, field: string, nonEmpty: boolean): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError(`${field} must be a${nonEmpty ? " non-empty" : ""} well-formed string`)
  }
  return value
}

/** Preserves Error identity and normalizes non-Error boundary failures with their cause. */
function boundaryError(value: unknown): Error {
  return isError(value) ? value : new Error("client boundary rejected", { cause: value })
}

/** Creates one typed response validator whose result survives retry attempts. */
function newTypedResponseBoundary<Response extends Struct>(
  schema: Response
): readonly [
  validator: TypedResponseValidator,
  result: () => readonly [Infer<Response>] | null,
  decode: (message: Message) => Promise<Infer<Response>>
] {
  let result: readonly [Infer<Response>] | null = null

  /** Decodes and captures the latest successful response attempt. */
  async function decode(response: Message): Promise<Infer<Response>> {
    try {
      const value = messageContentType(response.header)
      if (value === null || mediaType(value) !== jsonContentType) {
        throw new TypeError("unexpected response Content-Type")
      }
      const decoded = decodeJsonBody(schema, response.body)
      const captured: readonly [Infer<Response>] = Object.freeze([decoded])
      result = captured
      return decoded
    } catch (value) {
      throw newTransportProtocolError("client typed response is invalid", boundaryError(value))
    }
  }

  /** Validates and captures one attempt for selector, retry, and middleware feedback. */
  async function validate(response: Message): Promise<void> {
    await decode(response)
  }

  /** Returns the latest captured response tuple without inventing a sentinel value. */
  function capturedResult(): readonly [Infer<Response>] | null {
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
  replyMetadata: Metadata | null
): Error | null {
  try {
    const feedbackContext = withoutCancel(ctx)
    const error = selectionFailure()
    const outcome: SelectionOutcome =
      replyMetadata === null
        ? Object.freeze({ error, bytesSent, bytesReceived })
        : Object.freeze({ error, replyMetadata, bytesSent, bytesReceived })
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

/** Rejects caller ownership of routing and Context metadata headers reserved by this Client. */
function rejectReservedHeaders(message: Message): void {
  for (const name of Object.keys(message.header)) {
    const lower = name.toLowerCase()
    if (
      lower === serviceHeaderLower ||
      lower === endpointHeaderLower ||
      lower === metadataHeaderLower
    ) {
      throw new TypeError(`message header ${name} is reserved by @go-like/client`)
    }
  }
}

/** Projects routing and canonical client Context metadata into one detached unary header record. */
function unaryRequestHeaders(
  ctx: Context,
  header: Readonly<Record<string, string>>,
  service: string,
  endpoint: string
): Readonly<Record<string, string>> {
  const entries = Object.entries(header)
  entries.push([serviceHeader, service], [endpointHeader, endpoint])
  const encoded = encodeMetadataHeader(fromClientContext(ctx) ?? emptyMetadata)
  if (encoded !== null) entries.push([metadataHeader, encoded])
  return Object.fromEntries(entries)
}

/** Projects real wire entries in one pass without making Metadata validity a protocol gate. */
function wireHeaderMetadata(entries: readonly (readonly [string, string])[]): Metadata {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of entries) {
    if (key.length === 0 || !isWellFormed(key) || !isWellFormed(value)) continue
    const normalized = key.toLowerCase()
    const values = grouped.get(normalized)
    if (values === undefined) grouped.set(normalized, [value])
    else values.push(value)
  }
  return newMetadata(Object.fromEntries(grouped))
}

/** Projects one Message header record to an immutable observable snapshot. */
function messageHeaderMetadata(headers: Readonly<Record<string, string>>): Metadata {
  return wireHeaderMetadata(Object.entries(headers))
}

/** Creates one call-scoped dynamic TransportInfo facade without making observation a call gate. */
function newCallTransportContext(
  ctx: Context,
  kind: string,
  operation: string
): readonly [Context, CallTransportState] {
  let target = ""
  let requestHeaders = emptyMetadata
  let replyHeaders = emptyMetadata
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
      return requestHeaders
    },
    replyHeaders(): Metadata {
      return replyHeaders
    }
  }
  const state: CallTransportState = Object.freeze({
    beginAttempt(nextTarget: string, nextRequestHeaders: Metadata): void {
      target = nextTarget
      requestHeaders = nextRequestHeaders
      replyHeaders = emptyMetadata
    },
    updateReply(nextReplyHeaders: Metadata): void {
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
  if (typeof url !== "string" || url.length === 0 || !isWellFormed(url)) {
    throw new TypeError("Selector.select endpoint url must be a non-empty well-formed string")
  }
  if (typeof complete !== "function") {
    throw new TypeError("Selector.select completion callback must be a function")
  }
  return Object.freeze([url, complete as SelectionDone])
}

/** Describes one unary service call over an opaque Transport Message. */
export interface CallRequest {
  readonly service: string
  readonly endpoint: string
  readonly message: Message
}

/** Resolves and performs one unary internal service call at a time. */
export interface Client {
  /** Calls one typed endpoint while preserving the raw Message API. */
  call<Request extends Struct, Response extends Struct>(
    ctx: Context,
    endpoint: Endpoint<Request, Response>,
    request: NoInfer<Infer<Request>>,
    ...options: readonly CallOption[]
  ): Promise<Infer<Response>>
  /** Discovers, selects, and exchanges one Message under the caller Context. */
  call(ctx: Context, request: CallRequest, ...options: readonly CallOption[]): Promise<Message>
  /** Stops every resident transport connection and discovery watcher owned by this Client. */
  close(ctx: Context): Promise<void>
}

/** Captures the immutable routing and retry settings for one unary call. */
export interface CallOptions {
  /** Direct transport address, bypassing Discovery and Selector when present. */
  readonly address: string | null
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
export type Call = Handler<CallRequest, Promise<Message>, readonly CallOption[]>

/** Wraps one unary Client call with explicit caller-owned behavior. */
export type ClientMiddleware = Middleware<CallRequest, Promise<Message>, readonly CallOption[]>

/** Captures the immutable construction settings used by one Client. */
export interface ClientOptions {
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
    Reflect.get(value, "message") !== undefined
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

/** Configures the service Discovery used by future calls. */
export function withDiscovery(value: Discovery): ClientOption {
  if (!isDiscovery(value)) throw new TypeError("discovery must implement Discovery")
  return (options) =>
    snapshotClientOptions({
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
      const result = await breaker.execute<Message | CleanupRetryResult>(
        ctx,
        async (operationContext): Promise<Message | CleanupRetryResult> => {
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

/** Copies and validates one complete per-call option snapshot. */
function snapshotCallOptions(value: unknown): CallOptions {
  if (!isCallOptionsCandidate(value)) {
    throw new TypeError("Call options must be an object")
  }
  return Object.freeze({
    address: value.address === null ? null : callText(value.address, "CallOptions.address", true),
    filters: snapshotFilters(value.filters),
    retry: snapshotCallRetry(value.retry)
  })
}

/** Uses one direct transport address instead of Discovery and Selector for a call. */
export function withAddress(value: string): CallOption {
  const captured = callText(value, "withAddress value", true)
  return (options) =>
    snapshotCallOptions({
      address: captured,
      filters: options.filters,
      retry: options.retry
    })
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
      address: options.address,
      filters: options.filters.concat(captured),
      retry: options.retry
    })
}

/** Enables bounded retries only with explicit idempotent or caller-approved replay authorization. */
export function withRetry(options: CallRetryOptions): CallOption {
  const captured = snapshotCallRetry(options)
  return (current) =>
    snapshotCallOptions({
      address: current.address,
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
  discovery: Discovery | null,
  selector: Selector | null,
  transport: Transport,
  config: ClientOptions
): Client {
  const resolver = discovery === null ? null : newDiscoveryResolver(discovery)
  const getService = resolver?.getService ?? null
  const select = selector?.select ?? null
  const dial = transport.dial
  const kind = transportKind(transport)
  const closedError = new Error("client is closed")
  const idle = new Map<string, ResidentTransportClient>()
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
    if (idle.get(client.address) === client) idle.delete(client.address)
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
      if (client.idleTimer !== timer || idle.get(client.address) !== client) return
      client.idleTimer = null
      void closeResident(client)
    }, idleTtlMs)
    client.idleTimer = timer
  }

  /** Borrows one idle endpoint owner or dials and captures a new one. */
  async function acquire(ctx: Context, address: string): Promise<ResidentTransportClient> {
    if (closed) throw closedError
    const available = idle.get(address)
    if (available !== undefined) {
      idle.delete(address)
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
        throw new TypeError("transport dial must return a Client with send, recv, and close")
      }
      let admittedSend: unknown
      let admittedRecv: unknown
      try {
        admittedSend = admitted.send
        admittedRecv = admitted.recv
        if (typeof admittedSend !== "function" || typeof admittedRecv !== "function") {
          throw new TypeError("transport dial must return a Client with send, recv, and close")
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
        send: admittedSend as TransportClient["send"],
        recv: admittedRecv as TransportClient["recv"],
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
    if (
      reusable &&
      !closed &&
      maxIdle > 0 &&
      client.closing === null &&
      !idle.has(client.address)
    ) {
      idle.set(client.address, client)
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

  /** Performs one selected or direct dial-send-recv attempt with exact cleanup ownership. */
  async function attempt(
    ctx: Context,
    service: string,
    operation: string,
    outbound: Message,
    options: CallOptions
  ): Promise<Message> {
    let complete: SelectionDone | null = null
    let transportClient: ResidentTransportClient | null = null
    let primary: Error | null = null
    let response: Message | null = null
    let bytesSent = false
    let bytesReceived = false
    let replyMetadata: Metadata | null = null
    try {
      let address: string
      if (options.address === null) {
        if (discovery === null || selector === null || getService === null || select === null) {
          throw new TypeError("client call without a direct address requires discovery")
        }
        const instances = filteredInstances(
          await getService.call(resolver, ctx, service, config.block === true),
          options.filters
        )
        const selection = snapshotSelection(select.call(selector, ctx, instances))
        complete = selection[1]
        address = selection[0]
      } else {
        address = options.address
      }
      let attemptContext = ctx
      let projected = callTransportState(ctx)
      if (projected === null) {
        const created = newCallTransportContext(ctx, kind, operation)
        attemptContext = created[0]
        projected = created[1]
      }
      projected.beginAttempt(address, messageHeaderMetadata(outbound.header))
      transportClient = await acquire(attemptContext, address)
      await transportClient.send.call(transportClient.receiver, attemptContext, outbound)
      bytesSent = true
      const candidate = await transportClient.recv.call(transportClient.receiver, attemptContext)
      bytesReceived = true
      const received = snapshotMessage(candidate)
      replyMetadata = messageHeaderMetadata(received.header)
      response = received
      projected.updateReply(replyMetadata)
      const serviceFailure = decodeServiceError("unary", 200, received.header, received.body)
      if (serviceFailure !== null) throw serviceFailure
      const validator = typedResponseValidator(ctx)
      if (validator !== null) await validator.validate(received)
      return received
    } catch (value) {
      primary = boundaryError(value)
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
          throw new AggregateError(
            [primary, feedbackFailure, closeFailure],
            "client call and cleanup failed"
          )
        }
        throw new AggregateError([primary, feedbackFailure], "client call and feedback failed")
      }
      if (primary !== null && closeFailure !== null) {
        throw new AggregateError([primary, closeFailure], "client call and close failed")
      }
      if (primary === null && response !== null) {
        const failures: Error[] = []
        if (feedbackFailure !== null) failures.push(feedbackFailure)
        if (closeFailure !== null) failures.push(closeFailure)
        if (failures.length !== 0) {
          throw newCompletedCallFailure(snapshotMessage(response), failures)
        }
      }
    }
  }

  /** Snapshots one logical call and performs one attempt unless replay was explicitly authorized. */
  const baseCall: Call = async function baseCall(ctx, request, ...values): Promise<Message> {
    const service = callName(request.service, "service")
    const endpoint = callName(request.endpoint, "endpoint")
    if (closed) throw closedError
    const input = snapshotMessage(request.message)
    rejectReservedHeaders(input)
    const options = callOptions(values)
    const outbound = snapshotMessage({
      header: unaryRequestHeaders(ctx, input.header, service, endpoint),
      body: input.body
    })
    const operation = `${service}/${endpoint}`
    if (options.retry === null) return await attempt(ctx, service, operation, outbound, options)
    const retried = await retry<Message | CleanupRetryResult>(
      ctx,
      async function retryAttempt(attemptContext): Promise<Message | CleanupRetryResult> {
        try {
          return await attempt(attemptContext, service, operation, outbound, options)
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
  ): Promise<Message> {
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
  ): Promise<Message> {
    const resolved = callOptions(options)
    const logicalContext = logicalTransportContext(ctx, request, kind)
    return await composedCall(logicalContext, request, function resolvedCallOptions(): CallOptions {
      return resolved
    })
  }

  /** Calls one typed endpoint contract. */
  function call<Request extends Struct, Response extends Struct>(
    ctx: Context,
    contract: Endpoint<Request, Response>,
    request: NoInfer<Infer<Request>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Infer<Response>>

  /** Calls one raw Message endpoint. */
  function call(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves call options. */
  ): Promise<Message>

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
      message: {
        header: { [contentTypeHeader]: jsonContentType },
        body
      }
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

  /** Starts the single combined transport and discovery owner drain. */
  function beginClientClose(): Promise<void> {
    if (clientClosing !== null) return clientClosing
    const operations: Promise<void>[] = [beginTransportClose()]
    if (resolver !== null) operations.push(resolver.close(background()))
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

  return Object.freeze({ call, close })
}

/** Creates one lightweight unary Client from go-micro-style functional options. */
export function newClient(...options: readonly ClientOption[]): Client {
  const resolved = clientOptions(options)
  if (resolved.transport === null) throw new TypeError("newClient requires a transport option")
  const selector =
    resolved.discovery !== null && resolved.selector === null
      ? newRoundRobinSelector()
      : resolved.selector
  return createClient(resolved.discovery, selector, resolved.transport, resolved)
}
