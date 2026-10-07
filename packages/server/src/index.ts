import {
  background,
  canceled,
  cause,
  withCancelCause,
  withDeadline,
  type CancelFunc,
  type Context
} from "@go-like/context"
import type { Endpointer, Server as LifecycleServer } from "@go-like/core"
import { waitForContext } from "@go-like/core/lifecycle"
import { newServerContext } from "@go-like/metadata"
import type { RateLimiter } from "@go-like/resilience"
import type { Infer, Struct } from "@go-like/struct"
import {
  endpoint as endpointContract,
  isServiceError,
  observeResponseBody,
  serviceError,
  type Endpoint,
  type ListenOption,
  type Listener,
  type Transport,
  type TransportHandler
} from "@go-like/transport"
import { metadata as metadataHeader, timeout as timeoutHeader } from "@go-like/transport/headers"
import { decodeJsonBody, encodeJsonBody, jsonContentType } from "@go-like/transport/json"
import {
  decodeMetadataHeader,
  internalServiceError,
  serviceErrorResponse
} from "@go-like/transport/provider"

import { maxSendMessageBytesValue, streamKeepAliveValue, typedStreamHandler } from "./stream"

const DefaultAddress = "127.0.0.1:0"
const RouteTokenPattern = /^[A-Za-z0-9._~-]+$/
const TimeoutHeaderPattern = /^(?:0|[1-9][0-9]*)$/

/** Handles one internal unary request. */
export type Handler = (ctx: Context, request: Request) => Response | Promise<Response>

/** Handles one typed internal unary request. */
export type TypedHandler<Request extends Struct, Response extends Struct> = (
  ctx: Context,
  request: Infer<Request>
) => Infer<Response> | Promise<Infer<Response>>

/** Wraps one internal unary handler. */
export type Middleware = (next: Handler) => Handler

/** Records one exact HTTP method and pathname mapped onto a unary endpoint. */
export interface HTTPRoute {
  readonly method: string
  readonly path: string
  readonly service: string
  readonly endpoint: string
  readonly successStatus: number
}

/** Holds the effective server construction options. */
export interface ServerOptions {
  readonly address: string
  readonly advertise: string | null
  readonly transport: Transport | null
  readonly middleware: readonly Middleware[]
  readonly operationMiddleware: ReadonlyMap<string, readonly Middleware[]>
  readonly listenOptions: readonly ListenOption[]
  readonly httpRoutes: readonly HTTPRoute[]
  /** Idle SSE comment interval in milliseconds. Zero sends only the initial comment. */
  readonly streamKeepAliveMs: number
  /** Maximum UTF-8 size of one encoded SSE event, including its framing. */
  readonly maxSendMessageBytes: number
}

/** Applies one Go-style server option. */
export type ServerOption = (options: ServerOptions) => ServerOptions

/** One typed endpoint binding installed by a single batch registration. */
export interface HandlerRegistration {
  readonly endpoint: Endpoint
  readonly handler: (ctx: Context, request: unknown) => unknown
}

/** Registers raw or typed handlers before the Server lifecycle begins. */
export interface HandlerRegistrar {
  registerHandler<Request extends Struct, Response extends Struct>(
    endpoint: Endpoint<Request, Response, false>,
    handler: TypedHandler<Request, Response>
  ): void

  registerHandler<Request extends Struct, Response extends Struct>(
    endpoint: Endpoint<Request, Response, true>,
    handler: (ctx: Context, request: Infer<Request>) => AsyncIterable<Infer<Response>>
  ): void

  registerHandler(service: string, endpoint: string, handler: Handler): void

  /** Installs every typed handler only after the whole list validates. */
  registerHandlers(handlers: readonly HandlerRegistration[]): void
}

/** Runs one internal transport listener under the application lifecycle. */
export interface Server extends LifecycleServer, Endpointer, HandlerRegistrar {
  /** Returns the selected Transport protocol discriminator. */
  protocol(): string

  /** Returns the actual endpoint after the transport bind completes. */
  endpoint(ctx: Context): Promise<string>

  /** Returns the current immutable option snapshot. */
  options(): ServerOptions

  /** Returns the stable implementation name. */
  string(): string
}

/** Validates one non-empty text option. */
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`server ${field} must be a non-empty string`)
  }
  return value
}

/** Parses one absolute transport endpoint when value includes a hierarchical host. */
function absoluteEndpoint(value: string): URL | null {
  try {
    const endpoint = new URL(value)
    return endpoint.hostname.length === 0 ? null : endpoint
  } catch {
    return null
  }
}

/** Parses one host or host:port advertise authority without guessing a scheme. */
function advertiseAuthority(value: string): URL {
  let authority: URL
  try {
    authority = new URL(`go-like://${value}`)
  } catch {
    throw new TypeError("server advertise must be an absolute endpoint, host, or host:port")
  }
  if (
    authority.hostname.length === 0 ||
    authority.username.length > 0 ||
    authority.password.length > 0 ||
    authority.pathname.length > 0 ||
    authority.href.includes("?") ||
    authority.href.includes("#")
  ) {
    throw new TypeError("server advertise must be an absolute endpoint, host, or host:port")
  }
  return authority
}

/** Validates one explicit advertise endpoint or authority. */
function advertiseValue(value: unknown): string {
  const selected = text(value, "advertise")
  const endpoint = absoluteEndpoint(selected)
  if (endpoint === null) advertiseAuthority(selected)
  else if (endpoint.username !== "" || endpoint.password !== "" || endpoint.href.includes("#")) {
    throw new TypeError("server advertise endpoint must not contain credentials or a fragment")
  }
  return selected
}

/** Reports whether a value is one URL-unreserved service or endpoint route token. */
function isRouteToken(value: unknown): value is string {
  return (
    typeof value === "string" && RouteTokenPattern.test(value) && value !== "." && value !== ".."
  )
}

/** Validates one unambiguous service or endpoint route token. */
function routeToken(value: unknown, field: string): string {
  if (!isRouteToken(value)) {
    throw new TypeError(`server ${field} must be a URL unreserved route token`)
  }
  return value
}

/** Validates one exact or trailing-wildcard operation selector. */
function operationSelector(value: unknown): string {
  const selector = text(value, "middleware selector")
  const wildcard = selector.indexOf("*")
  if (wildcard >= 0 && wildcard !== selector.length - 1) {
    throw new TypeError("server middleware selector must be exact or end with one *")
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
      "server middleware selector must identify a canonical operation or trailing wildcard"
    )
  }
  return selector
}

/** Validates one structural Transport. */
function transportValue(value: Transport | null): Transport | null {
  if (value === null) return null
  if (
    typeof value !== "object" ||
    typeof value.listen !== "function" ||
    typeof value.dial !== "function"
  ) {
    throw new TypeError("server transport must implement Transport")
  }
  return value
}

/** Requires one configured structural Transport. */
function requiredTransport(value: Transport | null): Transport {
  const selected = transportValue(value)
  if (selected === null) throw new TypeError("server transport is required")
  return selected
}

/** Validates one HTTP method token and stores it in uppercase. */
function httpMethod(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z]+$/u.test(value)) {
    throw new TypeError("server httpRoute method must be an HTTP method token")
  }
  return value.toUpperCase()
}

/** Validates one exact pathname without query or fragment. */
function httpPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("server httpRoute path must be a non-empty string")
  }
  if (value.includes("?") || value.includes("#")) {
    throw new TypeError("server httpRoute path must not include query or fragment")
  }
  return value
}

/** Validates one HTTP success carrier or defaults to 200. */
function httpSuccessStatus(value: unknown): number {
  if (value === undefined) return 200
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new TypeError("server httpRoute successStatus must be an HTTP status code")
  }
  return value
}

/** Validates one httpRoute snapshot entry. */
function httpRouteValue(value: unknown): HTTPRoute {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("server httpRoute must be an object")
  }
  const record = value as {
    readonly method?: unknown
    readonly path?: unknown
    readonly service?: unknown
    readonly endpoint?: unknown
    readonly successStatus?: unknown
  }
  return Object.freeze({
    method: httpMethod(record.method),
    path: httpPath(record.path),
    service: routeToken(record.service, "service"),
    endpoint: routeToken(record.endpoint, "endpoint"),
    successStatus: httpSuccessStatus(record.successStatus)
  })
}

/** Copies httpRoute entries and rejects duplicated method+path pairs. */
function snapshotHttpRoutes(value: unknown): readonly HTTPRoute[] {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value)) throw new TypeError("server httpRoutes must be an array")
  const routes: HTTPRoute[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const route = httpRouteValue(entry)
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) throw new TypeError(`server httpRoute is duplicated: ${key}`)
    seen.add(key)
    routes.push(route)
  }
  return Object.freeze(routes)
}

/** Accepts a construction snapshot whose stream limits may still be defaulted. */
type ServerOptionsDraft = Omit<ServerOptions, "streamKeepAliveMs" | "maxSendMessageBytes"> & {
  readonly streamKeepAliveMs?: number
  readonly maxSendMessageBytes?: number
}

/** Returns a defensive immutable server option snapshot. */
function snapshotOptions(value: ServerOptionsDraft): ServerOptions {
  const middlewareValues: Middleware[] = []
  for (const wrapper of value.middleware) middlewareValues.push(middlewareValue(wrapper))
  const operationMiddleware = new Map<string, readonly Middleware[]>()
  for (const [selector, values] of value.operationMiddleware) {
    const selected: Middleware[] = []
    for (const wrapper of values) selected.push(middlewareValue(wrapper))
    operationMiddleware.set(operationSelector(selector), Object.freeze(selected))
  }
  const listenValues: ListenOption[] = []
  for (const option of value.listenOptions) {
    if (typeof option !== "function") throw new TypeError("server listen option must be a function")
    listenValues.push(option)
  }
  return Object.freeze({
    address: text(value.address, "address"),
    advertise: value.advertise === null ? null : advertiseValue(value.advertise),
    transport: transportValue(value.transport),
    middleware: Object.freeze(middlewareValues),
    operationMiddleware,
    listenOptions: Object.freeze(listenValues),
    httpRoutes: snapshotHttpRoutes(value.httpRoutes),
    streamKeepAliveMs: streamKeepAliveValue(value.streamKeepAliveMs),
    maxSendMessageBytes: maxSendMessageBytesValue(value.maxSendMessageBytes)
  })
}

/** Returns the default server option snapshot. */
function defaultOptions(): ServerOptions {
  return snapshotOptions({
    address: DefaultAddress,
    advertise: null,
    transport: null,
    middleware: Object.freeze([]),
    operationMiddleware: new Map(),
    listenOptions: Object.freeze([]),
    httpRoutes: Object.freeze([])
  })
}

/** Validates one unary handler. */
function handlerValue(value: Handler): Handler {
  if (typeof value !== "function") throw new TypeError("server handler must be a function")
  return value
}

/** Validates one unary middleware. */
function middlewareValue(value: Middleware): Middleware {
  if (typeof value !== "function") throw new TypeError("server middleware must be a function")
  return value
}

/** Configures the transport used by the server. */
export function transport(value: Transport): ServerOption {
  const selected = transportValue(value)
  /** Replaces the selected transport. */
  function applyTransport(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: selected,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyTransport
}

/** Configures the listener address. */
export function address(value: string): ServerOption {
  const selected = text(value, "address")
  /** Replaces the selected listener address. */
  function applyAddress(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: selected,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyAddress
}

/**
 * Configures the endpoint or host advertised after bind.
 *
 * A host without a port retains the listener's actual bound port.
 */
export function advertise(value: string): ServerOption {
  const selected = advertiseValue(value)
  /** Replaces the selected advertise endpoint or authority. */
  function applyAdvertise(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: selected,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyAdvertise
}

/** Returns one comparable media type without optional parameters. */
function mediaType(value: string): string {
  return (value.split(";", 1)[0] ?? "").trim().toLowerCase()
}

/** Reports whether the request media type is JSON, ignoring parameters. */
function jsonRequest(request: Request): boolean {
  const raw = request.headers.get("content-type")
  return raw !== null && mediaType(raw) === jsonContentType
}

/** Adapts one typed endpoint handler to the raw Fetch boundary. */
function typedHandler<RequestStruct extends Struct, ResponseStruct extends Struct>(
  contract: Endpoint<RequestStruct, ResponseStruct>,
  value: TypedHandler<RequestStruct, ResponseStruct>
): Handler {
  const selected = endpointContract(
    contract.service,
    contract.endpoint,
    contract.request,
    contract.response
  )

  /** Decodes one typed JSON request and encodes its typed JSON response. */
  async function handle(ctx: Context, request: Request): Promise<Response> {
    let input: Infer<RequestStruct>
    try {
      if (!jsonRequest(request)) throw new TypeError("unexpected request Content-Type")
      input = decodeJsonBody(selected.request, new Uint8Array(await request.arrayBuffer()))
    } catch (error) {
      if (isServiceError(error)) throw error
      throw serviceError("invalid_request", "invalid request body", 400)
    }

    const response = await value(ctx, input)
    try {
      return new Response(encodeJsonBody(selected.response, response) as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "content-type": jsonContentType }
      })
    } catch {
      throw serviceError("internal", "internal service error", 500)
    }
  }

  return handle
}

/** Appends global unary middleware in declaration order. */
export function middleware(
  ...values: readonly Middleware[] /* go-like-typed-rest: preserves ordered middleware. */
): ServerOption {
  const selected: Middleware[] = []
  for (const value of values) selected.push(middlewareValue(value))
  /** Adds the captured middleware sequence. */
  function applyMiddleware(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: Object.freeze(options.middleware.concat(selected)),
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyMiddleware
}

/** Creates unary middleware backed by one caller-owned shared rate limiter. */
export function rateLimitMiddleware(limiter: RateLimiter): Middleware {
  const candidate: unknown = limiter
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof limiter.allow !== "function" ||
    typeof limiter.snapshot !== "function"
  ) {
    throw new TypeError("rate limiter must implement RateLimiter")
  }

  /** Wraps one handler without creating operation-local limiter state. */
  function limit(next: Handler): Handler {
    const selected = handlerValue(next)

    /** Admits one request or rejects it with the canonical service error. */
    async function limited(ctx: Context, request: Request): Promise<Response> {
      const decision = limiter.allow(ctx)
      if (!decision.allowed) {
        throw serviceError("rate_limited", "rate limit exceeded", 429, {
          retryAfterMs: String(decision.retryAfterMs)
        })
      }
      return await selected(ctx, request)
    }
    return limited
  }
  return limit
}

/** Replaces middleware for one exact or trailing-wildcard operation selector. */
export function use(
  selector: string,
  ...values: readonly Middleware[] /* go-like-typed-rest: preserves ordered middleware. */
): ServerOption {
  const operation = operationSelector(selector)
  const selected: Middleware[] = []
  for (const value of values) selected.push(middlewareValue(value))
  /** Replaces the captured operation middleware sequence. */
  function applyUse(options: ServerOptions): ServerOptions {
    const operationMiddleware = new Map(options.operationMiddleware)
    operationMiddleware.set(operation, Object.freeze(selected))
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyUse
}

/** Appends transport-specific listen options. */
export function listenOption(
  ...values: readonly ListenOption[] /* go-like-typed-rest: preserves ordered listen options. */
): ServerOption {
  const selected: ListenOption[] = []
  for (const value of values) {
    if (typeof value !== "function") throw new TypeError("server listen option must be a function")
    selected.push(value)
  }
  /** Adds the captured listener options. */
  function applyListenOptions(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: Object.freeze(options.listenOptions.concat(selected)),
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyListenOptions
}

/** Maps one exact HTTP method and pathname onto an existing unary endpoint. */
export function httpRoute(
  method: string,
  path: string,
  service: string,
  endpoint: string,
  successStatus?: number
): ServerOption {
  const selected = httpRouteValue(
    Object.freeze({
      method,
      path,
      service,
      endpoint,
      successStatus
    })
  )
  /** Adds the validated HTTP path route. */
  function applyHttpRoute(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: Object.freeze(options.httpRoutes.concat(selected)),
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyHttpRoute
}

/** Sets the idle SSE comment interval. Zero keeps only the initial comment. */
export function streamKeepAlive(intervalMs: number): ServerOption {
  const selected = streamKeepAliveValue(intervalMs)
  /** Replaces the stream heartbeat interval. */
  function applyStreamKeepAlive(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: selected,
      maxSendMessageBytes: options.maxSendMessageBytes
    })
  }
  return applyStreamKeepAlive
}

/** Sets the maximum UTF-8 size of one encoded SSE event. */
export function maxSendMessageBytes(bytes: number): ServerOption {
  const selected = maxSendMessageBytesValue(bytes)
  /** Replaces the per-event send ceiling. */
  function applyMaxSendMessageBytes(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      httpRoutes: options.httpRoutes,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: selected
    })
  }
  return applyMaxSendMessageBytes
}

/** Finds one exact method+path route, or whether the pathname exists with another method. */
function lookupHttpRoute(
  method: string,
  path: string,
  routes: readonly HTTPRoute[]
): HTTPRoute | "method" | null {
  let pathMatched = false
  for (const route of routes) {
    if (route.path !== path) continue
    pathMatched = true
    if (route.method === method) return route
  }
  return pathMatched ? "method" : null
}

/** Lists the HTTP methods registered for one pathname, in declaration order. */
function allowedMethods(path: string, routes: readonly HTTPRoute[]): string {
  const methods: string[] = []
  for (const route of routes) {
    if (route.path === path && !methods.includes(route.method)) methods.push(route.method)
  }
  return methods.join(", ")
}

/** Reads Go-Like-Timeout-Ms, or returns null when the caller set no deadline. */
function timeoutMilliseconds(headers: Headers): number | null {
  const value = headers.get(timeoutHeader)
  if (value !== null && !TimeoutHeaderPattern.test(value)) {
    throw serviceError("invalid_request", "invalid timeout header", 400)
  }
  if (value === null) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw serviceError("invalid_request", "invalid timeout header", 400)
  }
  return parsed
}

/**
 * Builds the request Context from metadata and the propagated deadline.
 *
 * cancel is non-null only when the Server must release the deadline itself: a cancelable ctx is
 * canceled by Listener.serve once the Response body ends, which releases the deadline through
 * parent propagation.
 */
function requestContext(
  ctx: Context,
  request: Request,
  timeoutMs: number | null
): { readonly ctx: Context; readonly cancel: CancelFunc | null } {
  let next: Context
  try {
    next = newServerContext(ctx, decodeMetadataHeader(request.headers.get(metadataHeader)))
  } catch {
    throw serviceError("invalid_metadata", "invalid request metadata", 400)
  }
  if (timeoutMs === null) return { ctx: next, cancel: null }
  const [timed, cancel] = withDeadline(next, new Date(Date.now() + timeoutMs))
  return { ctx: timed, cancel: ctx.done() === null ? cancel : null }
}

/** Returns one Fetch ServiceError response, optionally advertising Allow. */
function errorResponse(failure: ReturnType<typeof serviceError>, allow?: string): Response {
  const response = serviceErrorResponse(failure)
  if (allow !== undefined) response.headers.set("allow", allow)
  return response
}

/** Returns the canonical not-found ServiceError response. */
function notFoundResponse(message = "not found"): Response {
  return errorResponse(serviceError("not_found", message, 404))
}

/** Splits an internal RPC pathname into exactly two non-empty segments. */
function rpcPath(path: string): readonly [string, string] | null {
  const matched = /^\/([^/]+)\/([^/]+)$/.exec(path)
  if (matched === null) return null
  const service = matched[1]
  const endpoint = matched[2]
  if (service === undefined || endpoint === undefined) return null
  if (!isRouteToken(service) || !isRouteToken(endpoint)) return null
  return [service, endpoint]
}

/** Composes middleware around one handler. */
function compose(handle: Handler, values: readonly Middleware[]): Handler {
  let composed = handle
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const wrapper = values[index]
    if (wrapper === undefined) continue
    composed = handlerValue(wrapper(composed))
  }
  return composed
}

/** Selects exact middleware or the longest matching trailing-wildcard prefix. */
function middlewareFor(
  operation: string,
  values: ReadonlyMap<string, readonly Middleware[]>
): readonly Middleware[] {
  const exact = values.get(operation)
  if (exact !== undefined) return exact
  let selected: readonly Middleware[] = Object.freeze([])
  let selectedLength = -1
  for (const [selector, middlewareValues] of values) {
    if (!selector.endsWith("*")) continue
    const prefix = selector.slice(0, -1)
    if (prefix.length <= selectedLength || !operation.startsWith(prefix)) continue
    selected = middlewareValues
    selectedLength = prefix.length
  }
  return selected
}

/** Encodes one safe service failure as a Fetch response. */
function failureResponse(value: unknown): Response {
  return serviceErrorResponse(isServiceError(value) ? value : internalServiceError())
}

/** Releases a deadline the transport cannot release once the delivered Response body ends. */
function releaseDeadline(response: Response, cancel: CancelFunc | null): Response {
  if (cancel === null) return response
  return observeResponseBody(response, function ended(): void {
    cancel()
  })
}

/** Replaces a successful httpRoute status without reading the body twice. */
function withSuccessStatus(response: Response, status: number): Response {
  if (response.status < 200 || response.status > 299 || response.status === status) return response
  return new Response(response.body, {
    status,
    statusText: response.statusText,
    headers: response.headers
  })
}

/** Creates the Fetch handler for one immutable route table. */
function dispatcher(
  handlers: ReadonlyMap<string, ReadonlyMap<string, Handler>>,
  middlewareValues: readonly Middleware[],
  operationMiddleware: ReadonlyMap<string, readonly Middleware[]>,
  httpRoutes: readonly HTTPRoute[]
): TransportHandler {
  const routes = new Map<string, ReadonlyMap<string, Handler>>()
  for (const [service, endpoints] of handlers) {
    const endpointHandlers = new Map<string, Handler>()
    for (const [endpoint, handle] of endpoints) {
      const selected = middlewareFor(`${service}/${endpoint}`, operationMiddleware)
      endpointHandlers.set(endpoint, compose(compose(handle, selected), middlewareValues))
    }
    routes.set(service, endpointHandlers)
  }

  /** Runs one registered endpoint and releases its deadline when the transport cannot. */
  async function callEndpoint(
    ctx: Context,
    request: Request,
    service: string,
    endpoint: string,
    successStatus: number | null,
    timeoutMs: number | null
  ): Promise<Response> {
    const handle = routes.get(service)?.get(endpoint) as Handler
    const opened = requestContext(ctx, request, timeoutMs)
    try {
      const produced = await handle(opened.ctx, request)
      if (!(produced instanceof Response)) throw internalServiceError()
      const response =
        successStatus === null ? produced : withSuccessStatus(produced, successStatus)
      return releaseDeadline(response, opened.cancel)
    } catch (value) {
      return releaseDeadline(failureResponse(value), opened.cancel)
    }
  }

  /** Dispatches one Fetch request by httpRoute, internal RPC path, health, then 404. */
  async function dispatch(ctx: Context, request: Request): Promise<Response> {
    try {
      const timeoutMs = timeoutMilliseconds(request.headers)
      const url = new URL(request.url)
      const path = url.pathname
      const method = request.method.toUpperCase()
      const matched = lookupHttpRoute(method, path, httpRoutes)
      if (typeof matched === "object" && matched !== null) {
        return await callEndpoint(
          ctx,
          request,
          matched.service,
          matched.endpoint,
          matched.successStatus,
          timeoutMs
        )
      }
      if (matched === "method") {
        return errorResponse(
          serviceError("method_not_allowed", "method not allowed", 405),
          allowedMethods(path, httpRoutes)
        )
      }
      const rpc = rpcPath(path)
      if (rpc !== null) {
        const [service, endpoint] = rpc
        if (routes.get(service)?.has(endpoint) !== true) {
          return notFoundResponse(`unknown service endpoint: ${service}/${endpoint}`)
        }
        if (method !== "POST") {
          return errorResponse(
            serviceError("method_not_allowed", "method not allowed", 405),
            "POST"
          )
        }
        if (!jsonRequest(request)) {
          return errorResponse(serviceError("invalid_request", "invalid request content type", 400))
        }
        return await callEndpoint(ctx, request, service, endpoint, null, timeoutMs)
      }
      if ((method === "GET" || method === "HEAD") && path === "/healthz") {
        return new Response(null, { status: 200 })
      }
      return notFoundResponse()
    } catch (value) {
      return failureResponse(value)
    }
  }
  return dispatch
}

/** One handler held until a single or batch registration commits. */
interface PreparedRegistration {
  readonly serviceName: string
  readonly endpointName: string
  readonly handler: Handler
}

/** Creates one go-micro-style internal service Server. */
export function newServer(
  ...values: readonly ServerOption[] /* go-like-typed-rest: preserves the Go-style option ABI. */
): Server {
  let options = defaultOptions()
  for (const option of values) {
    if (typeof option !== "function") throw new TypeError("server option must be a function")
    options = snapshotOptions(option(options))
  }
  const selectedTransport = requiredTransport(options.transport)
  const registrations = new Map<string, Map<string, Handler>>()
  let sealed = false
  let sealedDispatcher: TransportHandler | null = null
  let sealFailed = false
  let sealFailure: unknown

  let listener: Listener | null = null
  let binding: Promise<Listener> | null = null
  let closing: Promise<void> | null = null
  const bindOwner = withCancelCause(background())
  const bindClosedError = new Error("server stopped during transport bind")
  let actualAddress = options.address
  let started = false
  let stopping = false

  /** Registers one typed unary endpoint contract. */
  function registerHandler<Request extends Struct, Response extends Struct>(
    contract: Endpoint<Request, Response, false>,
    value: TypedHandler<Request, Response>
  ): void

  /** Registers one typed server-streaming endpoint contract. */
  function registerHandler<Request extends Struct, Response extends Struct>(
    contract: Endpoint<Request, Response, true>,
    value: (ctx: Context, request: Infer<Request>) => AsyncIterable<Infer<Response>>
  ): void

  /** Registers one raw service endpoint. */
  function registerHandler(service: string, endpoint: string, value: Handler): void

  /** Validates and stores one typed or raw handler while registration remains open. */
  function registerHandler<Request extends Struct, Response extends Struct>(
    serviceOrContract: string | Endpoint<Request, Response, boolean>,
    endpointOrHandler:
      | string
      | TypedHandler<Request, Response>
      | ((ctx: Context, request: Infer<Request>) => AsyncIterable<Infer<Response>>),
    value?: Handler
  ): void {
    if (sealed) throw new TypeError("server registration is sealed")
    const prepared =
      typeof serviceOrContract === "string"
        ? prepareRaw(serviceOrContract, endpointOrHandler, value)
        : prepareTyped(
            typeof serviceOrContract === "object" && serviceOrContract !== null
              ? endpointFields(serviceOrContract)
              : serviceOrContract,
            endpointOrHandler
          )
    if (sealed) throw new TypeError("server registration is sealed")
    rejectDuplicate(prepared.serviceName, prepared.endpointName)
    commitRegistrations([prepared])
  }

  /** Installs every typed handler only after the whole list validates. */
  function registerHandlers(handlers: readonly HandlerRegistration[]): void {
    if (sealed) throw new TypeError("server registration is sealed")
    if (!Array.isArray(handlers)) {
      throw new TypeError("server handler registrations must be an array")
    }
    const snapshots: Array<{ readonly endpoint: Endpoint; readonly handler: unknown }> = []
    for (const entry of handlers) {
      snapshots.push(registrationSnapshot(entry))
    }
    const prepared: PreparedRegistration[] = []
    const pending = new Map<string, Set<string>>()
    for (const binding of snapshots) {
      const item = prepareTyped(binding.endpoint, binding.handler)
      const names = pending.get(item.serviceName) ?? new Set<string>()
      if (names.has(item.endpointName)) {
        throw new TypeError(
          `server handler is duplicated: ${item.serviceName}/${item.endpointName}`
        )
      }
      names.add(item.endpointName)
      pending.set(item.serviceName, names)
      prepared.push(item)
    }
    if (sealed) throw new TypeError("server registration is sealed")
    for (const item of prepared) {
      rejectDuplicate(item.serviceName, item.endpointName)
    }
    commitRegistrations(prepared)
  }

  /** Validates one raw route and handler without touching the registry. */
  function prepareRaw(
    service: string,
    endpointName: unknown,
    value: unknown
  ): PreparedRegistration {
    return {
      serviceName: routeToken(service, "service"),
      endpointName: routeToken(endpointName, "endpoint"),
      handler: handlerValue(value as Handler)
    }
  }

  /** Validates one typed contract and adapts its handler without touching the registry. */
  function prepareTyped<Request extends Struct, Response extends Struct>(
    contract: Endpoint<Request, Response, boolean>,
    value: unknown
  ): PreparedRegistration {
    if (typeof value !== "function") {
      throw new TypeError("server typed handler must be a function")
    }
    if (contract.stream === true) {
      const selected = endpointContract(
        contract.service,
        contract.endpoint,
        contract.request,
        contract.response,
        true
      )
      return {
        serviceName: selected.service,
        endpointName: selected.endpoint,
        handler: typedStreamHandler(
          selected,
          value as (ctx: Context, request: Infer<Request>) => unknown,
          options.streamKeepAliveMs,
          options.maxSendMessageBytes
        )
      }
    }
    const selected = endpointContract(
      contract.service,
      contract.endpoint,
      contract.request,
      contract.response
    )
    return {
      serviceName: selected.service,
      endpointName: selected.endpoint,
      handler: typedHandler(selected, value as TypedHandler<Request, Response>)
    }
  }

  /** Copies one batch entry so later validation does not re-read its getters. */
  function registrationSnapshot(value: unknown): {
    readonly endpoint: Endpoint
    readonly handler: unknown
  } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("server handler registration must be an object")
    }
    const endpointValue: unknown = Reflect.get(value, "endpoint")
    if (
      typeof endpointValue !== "object" ||
      endpointValue === null ||
      Array.isArray(endpointValue)
    ) {
      throw new TypeError("server handler registration endpoint must be an object")
    }
    const handler: unknown = Reflect.get(value, "handler")
    return { endpoint: endpointFields(endpointValue), handler }
  }

  /** Copies endpoint contract fields into ordinary data properties. */
  function endpointFields(value: object): Endpoint {
    return {
      service: Reflect.get(value, "service"),
      endpoint: Reflect.get(value, "endpoint"),
      request: Reflect.get(value, "request"),
      response: Reflect.get(value, "response"),
      stream: Reflect.get(value, "stream")
    } as Endpoint
  }

  /** Rejects a route that is already installed. */
  function rejectDuplicate(serviceName: string, endpointName: string): void {
    if (registrations.get(serviceName)?.has(endpointName) === true) {
      throw new TypeError(`server handler is duplicated: ${serviceName}/${endpointName}`)
    }
  }

  /** Writes one fully validated batch into the registry. */
  function commitRegistrations(prepared: readonly PreparedRegistration[]): void {
    for (const item of prepared) {
      let endpoints = registrations.get(item.serviceName)
      if (endpoints === undefined) {
        endpoints = new Map()
        registrations.set(item.serviceName, endpoints)
      }
      endpoints.set(item.endpointName, item.handler)
    }
  }

  /** Returns the selected Transport protocol discriminator. */
  function protocol(): string {
    const kind = typeof selectedTransport.kind === "function" ? selectedTransport.kind() : null
    if (typeof kind !== "string" || kind.length === 0) {
      throw new TypeError("server transport kind must be a non-empty string")
    }
    return kind
  }

  /** Validates registration and composes exactly one terminal dispatcher or failure. */
  function seal(): TransportHandler {
    if (sealedDispatcher !== null) return sealedDispatcher
    if (sealFailed) throw sealFailure
    sealed = true
    try {
      if (registrations.size === 0) {
        throw new TypeError("server requires at least one registered handler")
      }
      for (const route of options.httpRoutes) {
        if (registrations.get(route.service)?.has(route.endpoint) !== true) {
          throw new TypeError(
            `server httpRoute target is not registered: ${route.service}/${route.endpoint}`
          )
        }
      }
      sealedDispatcher = dispatcher(
        registrations,
        options.middleware,
        options.operationMiddleware,
        options.httpRoutes
      )
      return sealedDispatcher
    } catch (error) {
      sealFailed = true
      sealFailure = error
      throw error
    }
  }

  /** Binds the transport once so endpoint discovery and start share the same listener. */
  async function bind(ctx: Context): Promise<Listener> {
    if (listener !== null) return await waitForContext(ctx, Promise.resolve(listener))
    if (binding === null) {
      const initialError = ctx.err()
      if (initialError !== null) throw cause(ctx) ?? initialError
      binding = selectedTransport
        .listen(
          bindOwner[0],
          options.address,
          ...options.listenOptions /* go-like-typed-spread: forwards listen options. */
        )
        .then(
          /** Captures the actual listener and address from the single bind. */
          function captureListener(accepted) {
            listener = accepted
            actualAddress = accepted.addr()
            return accepted
          }
        )
    }
    return await waitForContext(ctx, binding)
  }

  /** Converts the actual listener address to one absolute transport endpoint. */
  function boundEndpoint(): URL {
    const kind = protocol()
    const absolute = absoluteEndpoint(actualAddress)
    if (absolute !== null) return absolute
    const transportOptions = selectedTransport.options()
    const scheme =
      kind === "http" && (transportOptions.secure || transportOptions.tlsConfig !== null)
        ? "https"
        : kind
    return new URL(`${scheme}://${actualAddress}`)
  }

  /** Reports whether one normalized URL host is an unspecified bind address. */
  function wildcardHost(value: string): boolean {
    return value === "0.0.0.0" || value === "[::]"
  }

  /** Returns the explicit advertised endpoint without losing an ephemeral bound port. */
  function advertisedEndpoint(): string {
    const bound = boundEndpoint()
    const selected = options.advertise
    let endpoint = bound
    if (selected !== null) {
      const absolute = absoluteEndpoint(selected)
      if (absolute !== null) {
        endpoint = absolute
      } else {
        const authority = advertiseAuthority(selected)
        endpoint = new URL(bound.toString())
        endpoint.hostname = authority.hostname
        if (authority.port.length > 0) endpoint.port = authority.port
      }
    }
    if (wildcardHost(endpoint.hostname)) {
      if (selected === null) {
        throw new TypeError("server wildcard bound address requires explicit advertise")
      }
      throw new TypeError("server advertise must not use a wildcard host")
    }
    return endpoint.toString()
  }

  /** Binds once and resolves the actual service endpoint. */
  async function endpoint(ctx: Context): Promise<string> {
    seal()
    await bind(ctx)
    return advertisedEndpoint()
  }

  /** Starts the listener and blocks until it terminates. */
  async function start(ctx: Context): Promise<void> {
    const dispatch = seal()
    if (started) throw new Error("server may only be started once")
    started = true
    let accepted: Listener
    try {
      accepted = await bind(ctx)
    } catch (error) {
      if (stopping && (error === canceled || error === bindClosedError)) return
      throw error
    }
    if (stopping) {
      try {
        if (closing !== null) await closing
      } finally {
        listener = null
      }
      return
    }
    try {
      await accepted.serve(ctx, dispatch)
    } finally {
      listener = null
    }
  }

  /** Starts or joins listener close after any in-flight bind completes. */
  async function stop(ctx: Context): Promise<void> {
    const pending = binding
    if (pending === null) return
    if (closing !== null) {
      await waitForContext(ctx, closing)
      return
    }
    stopping = true
    closing = pending.then(
      /** Closes the single accepted listener and releases the live reference. */
      async function closeListener(accepted): Promise<void> {
        try {
          await accepted.close(background())
        } finally {
          if (listener === accepted) listener = null
        }
      },
      /** Treats only this Server's bind-owner cancellation as a clean pre-bind stop. */
      function closeCanceledBind(error: unknown): void {
        if (error === canceled || error === bindClosedError) return
        throw error
      }
    )
    bindOwner[1](bindClosedError)
    await waitForContext(ctx, closing)
  }

  return Object.freeze({
    start,
    stop,
    registerHandler,
    registerHandlers,
    protocol,
    endpoint,
    /** Returns the immutable construction snapshot. */
    options(): ServerOptions {
      return snapshotOptions(options)
    },
    /** Returns the stable implementation name. */
    string(): string {
      return "server"
    }
  })
}
