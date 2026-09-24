import type {
  DescMessage,
  DescMethodStreaming,
  DescMethodUnary,
  MessageInitShape,
  MessageShape
} from "@bufbuild/protobuf"
import type {
  ContextValues,
  StreamResponse,
  Transport as ConnectTransport,
  UnaryResponse
} from "@connectrpc/connect"
import {
  Http2SessionManager,
  createGrpcTransport,
  type GrpcTransportOptions
} from "@connectrpc/connect-node"
import { newDiscoveryResolver, type DiscoveryResolver } from "@go-like/client/discovery"
import {
  background,
  canceled,
  cause,
  withCancelCause,
  withTimeout,
  withoutCancel,
  type CancelFunc,
  type Context
} from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import {
  newRoundRobinSelector,
  type SelectionDone,
  type SelectionOutcome,
  type Selector,
  type ServiceInstance
} from "@go-like/registry"
import type { TLSConfig, TLSEncodedBytes } from "@go-like/transport"
import { Buffer } from "node:buffer"

import { fromCallContextValues } from "./context"
import { canonicalAddress, clientOptions, type ClientOption, type ClientOptions } from "./options"

type OfficialSessionManager = NonNullable<GrpcTransportOptions["sessionManager"]>
type ManagerTLSOptions = ConstructorParameters<typeof Http2SessionManager>[2]
type RequestArguments = Parameters<OfficialSessionManager["request"]>

/** Structural raw owner used only by the private construction seam. */
export interface ClientManager {
  readonly authority: string
  request(...args: RequestArguments): Promise<unknown>
  notifyResponseByteRead(stream: unknown): void
  abort(reason?: Error): void
}

/** Private factories for deterministic owner tests; not exported by the package. */
export interface ClientFactories {
  createManager(address: string, tls: ManagerTLSOptions): ClientManager
  createTransport(address: string, manager: OfficialSessionManager): ConnectTransport
}

/** A standard Connect Transport with one explicit LikeGo cleanup owner. */
export interface Client extends ConnectTransport {
  close(ctx: Context): Promise<void>
}

interface ContextLease {
  readonly ctx: Context
  readonly release: () => void
}

interface SelectedEndpoint {
  readonly endpoint: object
  readonly complete: SelectionDone
}

interface AddressOwner {
  readonly terminal: TerminalManager
  readonly transport: ConnectTransport
}

interface TerminalManager {
  readonly manager: OfficialSessionManager
  close(reason: Error): Promise<void>
}

interface ActiveStream {
  abort(reason: Error): void
  finish(error: Error | null): Error | null
  readonly termination: Promise<never>
  status(): {
    readonly finished: boolean
    readonly error: Error | null
    readonly setupPending: boolean
  }
}

const defaultFactories: ClientFactories = Object.freeze({
  createManager(address: string, tls: ManagerTLSOptions) {
    return new Http2SessionManager(address, undefined, tls) as unknown as ClientManager
  },
  createTransport(address: string, manager: OfficialSessionManager) {
    return createGrpcTransport({ baseUrl: address, sessionManager: manager })
  }
})

/** Preserves Error identity and supplies one stable boundary error otherwise. */
function boundaryError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("gRPC client boundary rejected", { cause: value })
}

/** Returns the effective terminal error of one Context when it has one. */
function contextError(ctx: Context): Error | null {
  try {
    return cause(ctx) ?? ctx.err()
  } catch (value) {
    return boundaryError(value)
  }
}

/** Leases call-specific bounds while preserving the carried Context's values and cancellation. */
function boundedContext(
  parent: Context,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): ContextLease {
  let ctx = parent
  const releases: CancelFunc[] = []
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const timed = withTimeout(ctx, timeoutMs)
    ctx = timed[0]
    releases.push(timed[1])
  }
  let removeSignal: (() => void) | null = null
  if (signal !== undefined && signal !== parent.done()) {
    const derived = withCancelCause(ctx)
    ctx = derived[0]
    const cancel = derived[1]
    releases.push(() => cancel(null))
    const abort = (): void =>
      cancel(contextError(parent) ?? (signal.reason instanceof Error ? signal.reason : canceled))
    if (signal.aborted) abort()
    else {
      signal.addEventListener("abort", abort, { once: true })
      removeSignal = () => signal.removeEventListener("abort", abort)
    }
  }
  return {
    ctx,
    release(): void {
      removeSignal?.()
      for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]?.()
    }
  }
}

/** Applies raw call bounds to the carried Like Context or an explicit background fallback. */
function callContext(
  values: ContextValues | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): ContextLease {
  return boundedContext(fromCallContextValues(values) ?? background(), signal, timeoutMs)
}

/** Converts portable TLS bytes into detached Node buffers. */
function tlsBuffer(value: TLSEncodedBytes | null): Buffer | undefined {
  return value === null ? undefined : Buffer.from(value.bytes)
}

/** Maps portable TLS fields only into the official manager's third constructor argument. */
function managerTLS(config: TLSConfig | null): ManagerTLSOptions {
  if (config === null) return undefined
  return {
    ca: tlsBuffer(config.caCertificate),
    cert: tlsBuffer(config.certificateChain),
    key: tlsBuffer(config.privateKey),
    servername: config.serverName ?? undefined
  }
}

/** Best-effort closes one stream admitted after its manager became terminal. */
function closeLateStream(stream: unknown, reason: Error): void {
  if (typeof stream !== "object" || stream === null) return
  let close: unknown
  try {
    close = Reflect.get(stream, "close")
  } catch {
    close = undefined
  }
  if (typeof close === "function") {
    try {
      Reflect.apply(close, stream, [])
      return
    } catch {
      // Fall through to the stronger generic destroy boundary.
    }
  }
  let destroy: unknown
  try {
    destroy = Reflect.get(stream, "destroy")
  } catch {
    return
  }
  if (typeof destroy === "function") {
    try {
      Reflect.apply(destroy, stream, [reason])
    } catch {
      // A late stream is already outside the caller's ownership boundary.
    }
  }
}

/** Gates one official manager terminally while draining every admitted request acquisition. */
function newTerminalManager(raw: ClientManager): TerminalManager {
  let terminalReason: Error | null = null
  let closing: Promise<void> | null = null
  const acquisitions = new Set<Promise<unknown>>()

  /** Re-aborts without allowing a raw cleanup failure to skip acquisition draining. */
  function abort(reason: Error): Error | null {
    try {
      raw.abort(reason)
      return null
    } catch (value) {
      return boundaryError(value)
    }
  }

  const manager: OfficialSessionManager = {
    authority: raw.authority,
    request(...args: RequestArguments) {
      if (terminalReason !== null) return Promise.reject(terminalReason)
      let inner: Promise<unknown>
      try {
        inner = Promise.resolve(raw.request(...args))
      } catch (value) {
        return Promise.reject(value)
      }
      let acquisition: Promise<unknown>
      acquisition = inner
        .then(
          (stream) => {
            if (terminalReason !== null) {
              closeLateStream(stream, terminalReason)
              abort(terminalReason)
              throw terminalReason
            }
            return stream
          },
          (value: unknown) => {
            if (terminalReason !== null) {
              abort(terminalReason)
              throw terminalReason
            }
            throw value
          }
        )
        .finally(() => acquisitions.delete(acquisition))
      acquisitions.add(acquisition)
      return acquisition as ReturnType<OfficialSessionManager["request"]>
    },
    notifyResponseByteRead(stream) {
      if (terminalReason !== null) return
      raw.notifyResponseByteRead(stream)
    }
  }

  return Object.freeze({
    manager,
    close(reason: Error): Promise<void> {
      if (closing !== null) return closing
      terminalReason = reason
      const firstAbort = abort(reason)
      closing = (async () => {
        await Promise.allSettled(acquisitions)
        const failures = [firstAbort].filter((value): value is Error => value !== null)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, "gRPC manager cleanup failed")
      })()
      void closing.catch(() => {})
      return closing
    }
  })
}

/** Creates one immutable direct instance snapshot for the requested service descriptor. */
function directSnapshot(service: string, addresses: readonly string[]): readonly ServiceInstance[] {
  const instance: ServiceInstance = Object.freeze({
    id: `direct:${service}`,
    name: service,
    version: "",
    metadata: Object.freeze({}),
    endpoints: addresses
  })
  return Object.freeze([instance])
}

/** Recovers synchronous Selector ownership before validating the selected URL. */
function selectedEndpoint(value: unknown): SelectedEndpoint {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Selector.select must return an endpoint and completion tuple")
  }
  const endpoint: unknown = value[0]
  const complete: unknown = value[1]
  if (typeof endpoint !== "object" || endpoint === null) {
    throw new TypeError("Selector.select endpoint must be an object")
  }
  if (typeof complete !== "function") {
    throw new TypeError("Selector.select completion must be a function")
  }
  return Object.freeze({ endpoint, complete: complete as SelectionDone })
}

/** Validates one selected native address after its completion callback is caller-owned. */
function selectedAddress(endpoint: object, tlsConfig: TLSConfig | null): string {
  const url = Reflect.get(endpoint, "url")
  if (typeof url !== "string") throw new TypeError("Selector.select endpoint requires a URL")
  const address = canonicalAddress(url)
  if (tlsConfig !== null && address.startsWith("http:")) {
    throw new TypeError("http gRPC addresses cannot use TLS configuration")
  }
  return address
}

/** Publishes one exactly-once synchronous feedback outcome. */
function publishFeedback(complete: SelectionDone, ctx: Context, error: Error | null): Error | null {
  const outcome: SelectionOutcome = Object.freeze({ error })
  try {
    const result: unknown = Reflect.apply(complete, undefined, [withoutCancel(ctx), outcome])
    if (
      ((typeof result === "object" && result !== null) || typeof result === "function") &&
      typeof Reflect.get(result, "then") === "function"
    ) {
      void Promise.resolve(result).catch(() => {})
      return new TypeError("Selector completion must be synchronous")
    }
    return null
  } catch (value) {
    return boundaryError(value)
  }
}

/** Preserves primary then feedback failure order at one synchronous completion boundary. */
function combinedFailure(
  primary: Error | null,
  feedback: Error | null,
  message: string
): Error | null {
  if (primary === null) return feedback
  if (feedback === null) return primary
  return new AggregateError([primary, feedback], message)
}

/** Combines only call and owner cancellation signals for upstream Connect. */
function upstreamSignal(
  ctx: Context,
  signal: AbortSignal | undefined,
  owner: AbortSignal
): AbortSignal {
  const signals: AbortSignal[] = [owner]
  if (signal !== undefined) signals.push(signal)
  const done = ctx.done()
  if (done !== null && !signals.includes(done)) signals.push(done)
  return signals.length === 1 ? owner : AbortSignal.any(signals)
}

/** Returns the failure that should be visible to Selector feedback. */
function outcomeError(ctx: Context, owner: AbortSignal, failure: unknown): Error {
  if (owner.aborted && owner.reason instanceof Error) return owner.reason
  return contextError(ctx) ?? boundaryError(failure)
}

/** Creates the managed Client from one fixed options snapshot and private native factories. */
function createClient(factories: ClientFactories, options: ClientOptions): Client {
  const closedError = new Error("gRPC client is closed")
  const selector: Selector = options.selector ?? newRoundRobinSelector()
  const resolver: DiscoveryResolver | null =
    options.discovery === null ? null : newDiscoveryResolver(options.discovery)
  const ownerController = new AbortController()
  const owners = new Map<string, Promise<AddressOwner>>()
  const createdOwners = new Set<AddressOwner>()
  const activeCalls = new Set<Promise<unknown>>()
  const activeStreams = new Set<ActiveStream>()
  const directSnapshots = new Map<string, readonly ServiceInstance[]>()
  let state: "open" | "closing" | "closed" = "open"
  let closing: Promise<void> | null = null

  /** Rejects admission after close has published its terminal state. */
  function requireOpen(): void {
    if (state !== "open") throw closedError
  }

  /** Resolves Discovery/direct instances and runs the one public Selector. */
  async function select(ctx: Context, service: string): Promise<SelectedEndpoint> {
    requireOpen()
    let instances: readonly ServiceInstance[]
    if (resolver === null) {
      let snapshot = directSnapshots.get(service)
      if (snapshot === undefined) {
        snapshot = directSnapshot(service, options.addresses)
        directSnapshots.set(service, snapshot)
      }
      instances = snapshot
    } else {
      if (options.service === null) throw new TypeError("gRPC discovery requires a service")
      instances = await resolver.getService(ctx, options.service, options.block)
      requireOpen()
    }
    return selectedEndpoint(selector.select(ctx, instances))
  }

  /** Returns the one memoized manager/transport owner for a canonical address. */
  async function addressOwner(address: string): Promise<AddressOwner> {
    requireOpen()
    let pending = owners.get(address)
    if (pending === undefined) {
      pending = Promise.resolve().then(() => {
        requireOpen()
        const terminal = newTerminalManager(
          factories.createManager(address, managerTLS(options.tlsConfig))
        )
        let transport: ConnectTransport
        try {
          transport = factories.createTransport(address, terminal.manager)
        } catch (value) {
          void terminal.close(boundaryError(value)).catch(() => {})
          throw value
        }
        const owner: AddressOwner = Object.freeze({
          terminal,
          transport
        })
        createdOwners.add(owner)
        return owner
      })
      owners.set(address, pending)
      void pending.catch(() => {
        if (owners.get(address) === pending) owners.delete(address)
      })
    }
    const owner = await pending
    requireOpen()
    return owner
  }

  /** Tracks a call promise before a close operation can snapshot active work. */
  function track<T>(operation: Promise<T>): Promise<T> {
    activeCalls.add(operation)
    void operation.then(
      () => activeCalls.delete(operation),
      () => activeCalls.delete(operation)
    )
    return operation
  }

  /** Invokes unary selection, official transport delegation, and one feedback settlement. */
  function unary<I extends DescMessage, O extends DescMessage>(
    method: DescMethodUnary<I, O>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: HeadersInit | undefined,
    input: MessageInitShape<I>,
    contextValues?: ContextValues
  ): Promise<UnaryResponse<I, O>> {
    const operation = Promise.resolve().then(async (): Promise<UnaryResponse<I, O>> => {
      requireOpen()
      const lease = callContext(contextValues, signal, timeoutMs)
      let complete: SelectionDone | null = null
      let primary: Error | null = null
      try {
        const initialContextError = contextError(lease.ctx)
        if (initialContextError !== null) throw initialContextError
        const selected = await select(lease.ctx, method.parent.typeName)
        complete = selected.complete
        const address = selectedAddress(selected.endpoint, options.tlsConfig)
        const selectedContextError = contextError(lease.ctx)
        if (selectedContextError !== null) throw selectedContextError
        requireOpen()
        const owner = await addressOwner(address)
        const ownerContextError = contextError(lease.ctx)
        if (ownerContextError !== null) throw ownerContextError
        requireOpen()
        const response = await owner.transport.unary(
          method,
          upstreamSignal(lease.ctx, signal, ownerController.signal),
          timeoutMs,
          header,
          input,
          contextValues
        )
        requireOpen()
        return response
      } catch (value) {
        primary = outcomeError(lease.ctx, ownerController.signal, value)
        throw primary
      } finally {
        const feedback = complete === null ? null : publishFeedback(complete, lease.ctx, primary)
        lease.release()
        const failure = combinedFailure(primary, feedback, "gRPC unary and feedback failed")
        if (failure !== primary && failure !== null) {
          // oxlint-disable-next-line eslint/no-unsafe-finally -- Preserve primary/feedback order.
          throw failure
        }
      }
    })
    return track(operation)
  }

  /** Wraps one upstream response iterable with explicit pre-next terminal methods. */
  function wrapStream<I extends DescMessage, O extends DescMessage>(
    response: StreamResponse<I, O>,
    call: ActiveStream
  ): StreamResponse<I, O> {
    const iterator = response.message[Symbol.asyncIterator]()
    const wrapped = {
      async next(value?: unknown) {
        const initial = call.status()
        if (initial.finished) {
          if (initial.error !== null) throw initial.error
          return { done: true as const, value: undefined }
        }
        try {
          const result = await Promise.race([iterator.next(value as never), call.termination])
          if (result.done === true) {
            const feedback = call.finish(null)
            if (feedback !== null) throw feedback
          }
          return result
        } catch (value) {
          const error = boundaryError(value)
          const feedback = call.finish(error)
          throw combinedFailure(error, feedback, "gRPC stream and feedback failed") ?? error
        }
      },
      async return(value?: unknown) {
        const existing = call.status()
        if (existing.finished) return { done: true as const, value }
        const error = canceled
        call.abort(error)
        let result: IteratorResult<MessageShape<O>, unknown> = { done: true, value }
        let primary: Error | null = null
        try {
          if (typeof iterator.return === "function") result = await iterator.return(value as never)
        } catch (cause) {
          primary = boundaryError(cause)
        }
        const feedback = call.finish(primary ?? error)
        const failure = combinedFailure(primary, feedback, "gRPC stream return and feedback failed")
        if (failure !== null) throw failure
        return result
      },
      async throw(value?: unknown) {
        const existing = call.status()
        if (existing.finished) throw existing.error ?? boundaryError(value)
        const requested = boundaryError(value)
        call.abort(requested)
        if (typeof iterator.throw !== "function") {
          const feedback = call.finish(requested)
          throw (
            combinedFailure(requested, feedback, "gRPC stream throw and feedback failed") ??
            requested
          )
        }
        let result: IteratorResult<MessageShape<O>, unknown>
        try {
          result = await iterator.throw(value)
        } catch (cause) {
          const primary = boundaryError(cause)
          const feedback = call.finish(primary)
          throw (
            combinedFailure(primary, feedback, "gRPC stream throw and feedback failed") ?? primary
          )
        }
        const feedback = call.finish(requested)
        if (feedback !== null) throw feedback
        return result
      },
      [Symbol.asyncIterator]() {
        return this
      }
    } as AsyncIterableIterator<MessageShape<O>>
    return {
      stream: response.stream,
      service: response.service,
      method: response.method,
      header: response.header,
      trailer: response.trailer,
      message: wrapped
    }
  }

  /** Invokes streaming selection and returns only an explicitly wrapped message iterator. */
  function stream<I extends DescMessage, O extends DescMessage>(
    method: DescMethodStreaming<I, O>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: HeadersInit | undefined,
    input: AsyncIterable<MessageInitShape<I>>,
    contextValues?: ContextValues
  ): Promise<StreamResponse<I, O>> {
    const operation = Promise.resolve().then(async (): Promise<StreamResponse<I, O>> => {
      requireOpen()
      const lease = callContext(contextValues, signal, timeoutMs)
      let complete: SelectionDone | null = null
      let streamCall: ActiveStream | null = null
      try {
        const initialContextError = contextError(lease.ctx)
        if (initialContextError !== null) throw initialContextError
        const selected = await select(lease.ctx, method.parent.typeName)
        complete = selected.complete
        const address = selectedAddress(selected.endpoint, options.tlsConfig)
        const selectedContextError = contextError(lease.ctx)
        if (selectedContextError !== null) throw selectedContextError
        requireOpen()
        const callController = new AbortController()
        let finished = false
        let setupPending = true
        let terminal: Error | null = null
        const termination = Promise.withResolvers<never>()
        void termination.promise.catch(() => {})
        const removers: (() => void)[] = []
        const finish = (error: Error | null): Error | null => {
          if (finished) return null
          finished = true
          for (const remove of removers) remove()
          if (streamCall !== null) activeStreams.delete(streamCall)
          const feedback = publishFeedback(selected.complete, lease.ctx, error)
          terminal = combinedFailure(error, feedback, "gRPC stream and feedback failed")
          if (terminal !== null) termination.reject(terminal)
          lease.release()
          return feedback
        }
        const abort = (reason: Error): void => {
          if (!callController.signal.aborted) callController.abort(reason)
        }
        streamCall = {
          abort,
          finish,
          termination: termination.promise,
          status: () => ({ finished, error: terminal, setupPending })
        }
        activeStreams.add(streamCall)
        const linkedSignals = [ownerController.signal, signal, lease.ctx.done()].filter(
          (value): value is AbortSignal => value !== undefined && value !== null
        )
        for (const linked of new Set(linkedSignals)) {
          const onAbort = (): void => {
            const reason =
              linked === ownerController.signal
                ? closedError
                : (contextError(lease.ctx) ??
                  (linked.reason instanceof Error ? linked.reason : canceled))
            abort(reason)
            finish(reason)
          }
          if (linked.aborted) onAbort()
          else {
            linked.addEventListener("abort", onAbort, { once: true })
            removers.push(() => linked.removeEventListener("abort", onAbort))
          }
        }
        const admitted = streamCall.status()
        if (admitted.finished) throw admitted.error ?? canceled
        requireOpen()
        const owner = await addressOwner(address)
        const afterOwner = streamCall.status()
        if (afterOwner.finished) throw afterOwner.error ?? canceled
        const response = await Promise.race([
          owner.transport.stream(
            method,
            callController.signal,
            timeoutMs,
            header,
            input,
            contextValues
          ),
          streamCall.termination
        ])
        const afterResponse = streamCall.status()
        if (afterResponse.finished) throw afterResponse.error ?? canceled
        requireOpen()
        setupPending = false
        return wrapStream(response, streamCall)
      } catch (value) {
        if (streamCall === null) {
          const primary = outcomeError(lease.ctx, ownerController.signal, value)
          const feedback = complete === null ? null : publishFeedback(complete, lease.ctx, primary)
          lease.release()
          if (feedback !== null) {
            throw new AggregateError([primary, feedback], "gRPC stream and feedback failed")
          }
          throw primary
        }
        const status = streamCall.status()
        const primary =
          status.finished && status.error !== null
            ? status.error
            : outcomeError(lease.ctx, ownerController.signal, value)
        streamCall.finish(primary)
        throw streamCall.status().error ?? primary
      }
    })
    return track(operation)
  }

  /** Starts one state-published background owner drain exactly once. */
  function beginClose(): Promise<void> {
    if (closing !== null) return closing
    state = "closing"
    const streamFeedbackFailures: Error[] = []
    for (const active of Array.from(activeStreams)) {
      const setupPending = active.status().setupPending
      active.abort(closedError)
      const feedback = active.finish(closedError)
      if (feedback !== null && !setupPending) streamFeedbackFailures.push(feedback)
    }
    ownerController.abort(closedError)
    for (const owner of createdOwners) void owner.terminal.close(closedError)
    const resolverClose = resolver === null ? Promise.resolve() : resolver.close(background())
    const ownerCloses = [...owners.values()].map(async (pending) => {
      try {
        const owner = await pending
        await owner.terminal.close(closedError)
      } catch (value) {
        if (value !== closedError) throw value
      }
    })
    const calls = [...activeCalls]
    closing = (async () => {
      const settled = await Promise.allSettled([resolverClose, ...ownerCloses, ...calls])
      state = "closed"
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
        .filter((value) => value !== closedError)
      failures.unshift(...streamFeedbackFailures)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "gRPC client cleanup failed")
    })()
    void closing.catch(() => {})
    return closing
  }

  /** Bounds only this close caller while the shared background drain continues. */
  function close(ctx: Context): Promise<void> {
    return waitForContext(ctx, beginClose())
  }

  return Object.freeze({ unary, stream, close })
}

/** Private deterministic construction seam, intentionally absent from `./native`. */
export function newClientForTest(
  factories: ClientFactories,
  ...options: readonly ClientOption[]
): Client {
  return createClient(factories, clientOptions(options))
}

/** Creates one managed standard-gRPC Client over official Connect Node primitives. */
export function newClient(...options: readonly ClientOption[]): Client {
  return createClient(defaultFactories, clientOptions(options))
}
