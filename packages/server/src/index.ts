import { background, canceled, cause, withCancelCause, type Context } from "@likego/context"
import type { Endpointer, Server as LifecycleServer } from "@likego/core"
import { waitForContext } from "@likego/core/lifecycle"
import { newServerContext } from "@likego/metadata"
import type { RateLimiter } from "@likego/resilience"
import {
  endpoint as endpointContract,
  isServiceError,
  serviceError,
  type Endpoint,
  type ListenOption,
  type Listener,
  type Message,
  type Socket,
  type Transport
} from "@likego/transport"
import {
  contentType as contentTypeHeader,
  endpoint as endpointHeader,
  metadata as metadataHeader,
  request as serviceHeader
} from "@likego/transport/headers"
import {
  decodeMetadataHeader,
  encodeServiceError,
  internalServiceError,
  snapshotMessage
} from "@likego/transport/provider"

const DefaultAddress = "127.0.0.1:0"

/** Handles one internal unary request. */
export type Handler = (ctx: Context, request: Message) => Message | PromiseLike<Message>

/** Handles one typed internal unary request. */
export type TypedHandler<Request, Response> = (
  ctx: Context,
  request: Request
) => Response | PromiseLike<Response>

/** Wraps one internal unary handler. */
export type Middleware = (next: Handler) => Handler

/** Holds the effective server construction options. */
export interface ServerOptions {
  readonly address: string
  readonly advertise: string | null
  readonly transport: Transport | null
  readonly handlers: ReadonlyMap<string, ReadonlyMap<string, Handler>>
  readonly middleware: readonly Middleware[]
  readonly operationMiddleware: ReadonlyMap<string, readonly Middleware[]>
  readonly listenOptions: readonly ListenOption[]
}

/** Applies one Go-style server option. */
export type ServerOption = (options: ServerOptions) => ServerOptions

/** Runs one internal transport listener under the application lifecycle. */
export interface Server extends LifecycleServer, Endpointer {
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
    authority = new URL(`likego://${value}`)
  } catch {
    throw new TypeError("server advertise must be an absolute endpoint, host, or host:port")
  }
  if (
    authority.hostname.length === 0 ||
    authority.username.length > 0 ||
    authority.password.length > 0 ||
    authority.pathname.length > 0 ||
    authority.search.length > 0 ||
    authority.hash.length > 0
  ) {
    throw new TypeError("server advertise must be an absolute endpoint, host, or host:port")
  }
  return authority
}

/** Validates one explicit advertise endpoint or authority. */
function advertiseValue(value: unknown): string {
  const selected = text(value, "advertise")
  if (absoluteEndpoint(selected) === null) advertiseAuthority(selected)
  return selected
}

/** Reports whether a value is one canonical service or endpoint route token. */
function isRouteToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]+$/u.test(value) && !/[/*]/u.test(value)
}

/** Validates one unambiguous service or endpoint route token. */
function routeToken(value: unknown, field: string): string {
  if (!isRouteToken(value)) {
    throw new TypeError(`server ${field} must be a visible ASCII route token`)
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

/** Returns a defensive immutable server option snapshot. */
function snapshotOptions(value: ServerOptions): ServerOptions {
  const handlers = new Map<string, ReadonlyMap<string, Handler>>()
  for (const [service, endpoints] of value.handlers) {
    const serviceName = routeToken(service, "service")
    const endpointHandlers = new Map<string, Handler>()
    for (const [endpoint, handle] of endpoints) {
      endpointHandlers.set(routeToken(endpoint, "endpoint"), handlerValue(handle))
    }
    handlers.set(serviceName, endpointHandlers)
  }
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
    handlers,
    middleware: Object.freeze(middlewareValues),
    operationMiddleware,
    listenOptions: Object.freeze(listenValues)
  })
}

/** Returns the default server option snapshot. */
function defaultOptions(): ServerOptions {
  return snapshotOptions({
    address: DefaultAddress,
    advertise: null,
    transport: null,
    handlers: new Map(),
    middleware: Object.freeze([]),
    operationMiddleware: new Map(),
    listenOptions: Object.freeze([])
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
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions
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
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions
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
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions
    })
  }
  return applyAdvertise
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

/** Adapts one typed endpoint handler to the raw Message boundary. */
function typedHandler<Request, Response>(
  contract: Endpoint<Request, Response>,
  value: TypedHandler<Request, Response>
): Handler {
  const selected = endpointContract(
    contract.service,
    contract.endpoint,
    contract.requestCodec,
    contract.responseCodec
  )

  /** Decodes one typed request and encodes its typed response. */
  async function handle(ctx: Context, request: Message): Promise<Message> {
    let input: Request
    try {
      const contentType = messageContentType(request.header)
      if (
        contentType === null ||
        mediaType(contentType) !== mediaType(selected.requestCodec.contentType)
      ) {
        throw new TypeError("unexpected request Content-Type")
      }
      input = await selected.requestCodec.decode(request.body)
    } catch {
      throw serviceError("invalid_request", "invalid request body", 400)
    }

    const response = await value(ctx, input)
    try {
      const body = await selected.responseCodec.encode(response)
      if (!(body instanceof Uint8Array)) throw new TypeError("body codec must return Uint8Array")
      return {
        header: { [contentTypeHeader]: selected.responseCodec.contentType },
        body
      }
    } catch {
      throw serviceError("internal", "internal service error", 500)
    }
  }

  return handle
}

/** Registers one typed endpoint contract. */
export function handler<Request, Response>(
  contract: Endpoint<Request, Response>,
  value: TypedHandler<Request, Response>
): ServerOption

/** Registers one raw service endpoint. */
export function handler(service: string, endpoint: string, value: Handler): ServerOption

/** Registers one typed contract or raw service endpoint. */
export function handler<Request, Response>(
  serviceOrContract: string | Endpoint<Request, Response>,
  endpointOrHandler: string | TypedHandler<Request, Response>,
  value?: Handler
): ServerOption {
  let serviceName: string
  let endpointName: string
  let selected: Handler
  if (typeof serviceOrContract === "string") {
    serviceName = routeToken(serviceOrContract, "service")
    endpointName = routeToken(endpointOrHandler, "endpoint")
    if (typeof value !== "function") throw new TypeError("server handler must be a function")
    selected = handlerValue(value)
  } else {
    if (typeof endpointOrHandler !== "function") {
      throw new TypeError("server typed handler must be a function")
    }
    const contract = endpointContract(
      serviceOrContract.service,
      serviceOrContract.endpoint,
      serviceOrContract.requestCodec,
      serviceOrContract.responseCodec
    )
    serviceName = contract.service
    endpointName = contract.endpoint
    selected = typedHandler(contract, endpointOrHandler)
  }
  /** Adds the validated service endpoint handler. */
  function applyHandler(options: ServerOptions): ServerOptions {
    const endpoints = new Map(options.handlers.get(serviceName))
    if (endpoints.has(endpointName)) {
      throw new TypeError(`server handler is duplicated: ${serviceName}/${endpointName}`)
    }
    endpoints.set(endpointName, selected)
    const handlers = new Map(options.handlers)
    handlers.set(serviceName, endpoints)
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      handlers,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions
    })
  }
  return applyHandler
}

/** Appends global unary middleware in declaration order. */
export function middleware(
  ...values: readonly Middleware[] /* likego-typed-rest: preserves ordered middleware. */
): ServerOption {
  const selected: Middleware[] = []
  for (const value of values) selected.push(middlewareValue(value))
  /** Adds the captured middleware sequence. */
  function applyMiddleware(options: ServerOptions): ServerOptions {
    return snapshotOptions({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      handlers: options.handlers,
      middleware: Object.freeze(options.middleware.concat(selected)),
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions
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
    async function limited(ctx: Context, request: Message): Promise<Message> {
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
  ...values: readonly Middleware[] /* likego-typed-rest: preserves ordered middleware. */
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
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware,
      listenOptions: options.listenOptions
    })
  }
  return applyUse
}

/** Appends transport-specific listen options. */
export function listenOption(
  ...values: readonly ListenOption[] /* likego-typed-rest: preserves ordered listen options. */
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
      handlers: options.handlers,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: Object.freeze(options.listenOptions.concat(selected))
    })
  }
  return applyListenOptions
}

/** Reads one required routing header. */
function routeHeader(header: Readonly<Record<string, string>>, name: string): string {
  const expected = name.toLowerCase()
  let found: string | null = null
  for (const key of Object.keys(header)) {
    if (key.toLowerCase() !== expected) continue
    if (found !== null) throw serviceError("invalid_request", `duplicate ${name} header`, 400)
    found = header[key] ?? ""
  }
  if (found === null || found.length === 0) {
    throw serviceError("invalid_request", `missing ${name} header`, 400)
  }
  try {
    return routeToken(found, name)
  } catch {
    throw serviceError("invalid_request", `invalid ${name} header`, 400)
  }
}

/** Builds the request Context from the transport metadata header. */
function requestContext(ctx: Context, request: Message): Context {
  let value: string | null = null
  for (const key of Object.keys(request.header)) {
    if (key.toLowerCase() !== metadataHeader.toLowerCase()) continue
    if (value !== null) throw serviceError("invalid_metadata", "duplicate metadata header", 400)
    value = request.header[key] ?? ""
  }
  try {
    return newServerContext(ctx, decodeMetadataHeader(value))
  } catch {
    throw serviceError("invalid_metadata", "invalid request metadata", 400)
  }
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

/** Encodes one safe service failure as a transport Message. */
function failureMessage(value: unknown): Message {
  const failure = isServiceError(value) ? value : internalServiceError()
  const envelope = encodeServiceError("unary", failure)
  return snapshotMessage({ header: envelope.header, body: envelope.body })
}

/** Creates the transport accept handler for one immutable route table. */
function dispatcher(
  handlers: ReadonlyMap<string, ReadonlyMap<string, Handler>>,
  middlewareValues: readonly Middleware[],
  operationMiddleware: ReadonlyMap<string, readonly Middleware[]>
): (ctx: Context, socket: Socket) => Promise<void> {
  const routes = new Map<string, ReadonlyMap<string, Handler>>()
  for (const [service, endpoints] of handlers) {
    const endpointHandlers = new Map<string, Handler>()
    for (const [endpoint, handle] of endpoints) {
      const selected = middlewareFor(`${service}/${endpoint}`, operationMiddleware)
      endpointHandlers.set(endpoint, compose(compose(handle, selected), middlewareValues))
    }
    routes.set(service, endpointHandlers)
  }

  /** Dispatches one unary request and always sends one response. */
  async function dispatch(ctx: Context, socket: Socket): Promise<void> {
    const request = snapshotMessage(await socket.recv(ctx))
    let response: Message
    try {
      const service = routeHeader(request.header, serviceHeader)
      const endpoint = routeHeader(request.header, endpointHeader)
      const handle = routes.get(service)?.get(endpoint)
      if (handle === undefined) {
        throw serviceError("not_found", `unknown service endpoint: ${service}/${endpoint}`, 404)
      }
      response = snapshotMessage(await handle(requestContext(ctx, request), request))
    } catch (value) {
      response = failureMessage(value)
    }
    await socket.send(ctx, response)
  }
  return dispatch
}

/** Creates one go-micro-style internal service Server. */
export function newServer(
  ...values: readonly ServerOption[] /* likego-typed-rest: preserves the Go-style option ABI. */
): Server {
  let options = defaultOptions()
  for (const option of values) {
    if (typeof option !== "function") throw new TypeError("server option must be a function")
    options = snapshotOptions(option(options))
  }
  const selectedTransport = requiredTransport(options.transport)
  if (options.handlers.size === 0) throw new TypeError("server requires at least one handler")

  let listener: Listener | null = null
  let binding: Promise<Listener> | null = null
  let closing: Promise<void> | null = null
  const bindOwner = withCancelCause(background())
  const bindClosedError = new Error("server stopped during transport bind")
  let actualAddress = options.address
  let started = false
  let stopping = false

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
          ...options.listenOptions /* likego-typed-spread: forwards listen options. */
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
    const absolute = absoluteEndpoint(actualAddress)
    if (absolute !== null) return absolute
    const kind = selectedTransport.kind?.()
    if (typeof kind !== "string" || kind.length === 0) {
      throw new TypeError("server transport kind is required for an authority address")
    }
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
    await bind(ctx)
    return advertisedEndpoint()
  }

  /** Starts the listener and blocks until it terminates. */
  async function start(ctx: Context): Promise<void> {
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
      await accepted.accept(
        ctx,
        dispatcher(options.handlers, options.middleware, options.operationMiddleware)
      )
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
