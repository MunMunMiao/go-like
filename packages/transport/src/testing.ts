import { background, canceled, withCancel, withTimeout, withValue } from "@go-like/context"
import type { Context } from "@go-like/context"

import { timeout } from "./options"
import type { Client, Listener, Message, Option, Socket, Transport } from "./types"

/** Creates a fresh structural Transport for one isolated conformance case. */
export type TransportFactory = () => Transport | PromiseLike<Transport>

/** Injects one real provider-owned listener failure without exposing provider internals. */
export interface TransportConformanceFaultHarness {
  /** Makes listener terminate unexpectedly with cause while ctx remains active. */
  failListener(ctx: Context, listener: Listener, cause: Error): void | PromiseLike<void>
}

/** Configures the provider-neutral Transport conformance suite. */
export interface TransportConformanceOptions {
  readonly listenAddress: string
  readonly faultHarness: TransportConformanceFaultHarness | null
  readonly operationTimeoutMs?: number
}

/** Describes one runner-neutral Transport conformance case. */
export interface TransportConformanceCase {
  readonly name: string
  /** Executes the case and rejects when the public contract is violated. */
  run(): Promise<void>
}

interface SnapshotConformanceOptions {
  readonly listenAddress: string
  readonly faultHarness: TransportConformanceFaultHarness | null
  readonly operationTimeoutMs: number
}

interface Deferred {
  readonly promise: Promise<void>
  /** Resolves the deferred operation exactly once. */
  resolve(): void
}

interface FulfilledOutcome<T> {
  readonly rejected: false
  readonly value: T
}

interface RejectedOutcome {
  readonly rejected: true
  readonly value: unknown
}

type Outcome<T = unknown> = FulfilledOutcome<T> | RejectedOutcome

/** Performs one best-effort conformance cleanup operation. */
type Cleanup = (ctx: Context) => void | PromiseLike<void>
/** Performs one bounded conformance scenario. */
type Scenario = (ctx: Context) => void | PromiseLike<void>

const DefaultConformanceTimeoutMs = 2_000

/** Creates one runner-neutral deferred signal. */
function deferred(): Deferred {
  const resolvers: (() => void)[] = []
  const promise = new Promise<void>((resolve) => {
    resolvers.push(resolve)
  })
  return Object.freeze({
    promise,
    /** Resolves the captured Promise. */
    resolve(): void {
      const resolve = resolvers.shift()
      if (resolve !== undefined) resolve()
    }
  })
}

/** Fails one transport conformance assertion with a stable diagnostic. */
function fail(message: string): never {
  throw new Error(message)
}

/** Captures fulfillment or rejection without leaving an unhandled Promise. */
async function outcome<T>(operation: PromiseLike<T>): Promise<Outcome<T>> {
  try {
    return Object.freeze({ rejected: false, value: await operation })
  } catch (failure) {
    return Object.freeze({ rejected: true, value: failure })
  }
}

/** Captures both a synchronous throw and an asynchronous rejection from one invocation. */
async function invokeOutcome<T>(operation: () => T | PromiseLike<T>): Promise<Outcome<T>> {
  try {
    return await outcome(Promise.resolve(operation()))
  } catch (failure) {
    return Object.freeze({ rejected: true, value: failure })
  }
}

/** Crosses one real Web task boundary before observing delayed lifecycle side effects. */
async function crossWebTaskBoundary(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** Bounds one operation with an existing owner Context. */
async function boundedWithContext<T>(
  ctx: Context,
  operation: (ctx: Context) => T | PromiseLike<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const timeout = new Promise<never>((_resolve, reject) => {
    /** Rejects the bounded wait when its private deadline or cancellation wins. */
    function onTimeout(): void {
      reject(
        new Error(`${label} did not settle within ${timeoutMs}ms`, {
          cause: ctx.err()
        })
      )
    }
    timeoutSignal.addEventListener("abort", onTimeout, { once: true })
  })
  const running = Promise.resolve().then(() => operation(ctx))
  return await Promise.race([running, timeout])
}

/** Bounds one conformance operation so a broken provider cannot hang the runner. */
async function bounded<T>(
  operation: (ctx: Context) => T | PromiseLike<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const [ctx, cancel] = withCancel(background())
  try {
    return await boundedWithContext(ctx, operation, timeoutMs, label)
  } finally {
    cancel()
  }
}

/** Runs every cleanup despite earlier failures and preserves one or many exact failures. */
async function cleanupAll(
  cleanups: readonly Cleanup[],
  timeoutMs: number,
  label: string
): Promise<void> {
  const failures: unknown[] = []
  let sequence = 0
  for (const cleanup of cleanups) {
    sequence += 1
    const result = await outcome(bounded(cleanup, timeoutMs, `${label} cleanup ${sequence}`))
    if (result.rejected) failures.push(result.value)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${label} cleanup failed`)
}

/** Runs one scenario and bounded cleanup while preserving both failures in order. */
async function withCleanup(
  scenario: Scenario,
  cleanups: readonly Cleanup[],
  timeoutMs: number,
  label: string
): Promise<void> {
  const [ownerCtx, cancelOwner] = withCancel(background())
  const [primary, cleaned] = await (async (): Promise<readonly [Outcome, Outcome]> => {
    try {
      const scenarioResult = await outcome(boundedWithContext(ownerCtx, scenario, timeoutMs, label))
      const cleanupResult = await outcome(cleanupAll(cleanups, timeoutMs, label))
      const results: readonly [Outcome, Outcome] = [scenarioResult, cleanupResult]
      return Object.freeze(results)
    } finally {
      cancelOwner()
    }
  })()
  if (primary.rejected && cleaned.rejected) {
    const failures: unknown[] = [primary.value]
    if (cleaned.value instanceof AggregateError) {
      for (const failure of cleaned.value.errors) failures.push(failure)
    } else {
      failures.push(cleaned.value)
    }
    throw new AggregateError(failures, `${label} and cleanup failed`)
  }
  if (primary.rejected) throw primary.value
  if (cleaned.rejected) throw cleaned.value
}

/** Creates one already-canceled Context for admission and caller-scope checks. */
function preCanceledContext(): Context {
  const [ctx, cancel] = withCancel(background())
  cancel()
  return ctx
}

/** Reads a structural stable-error code without requiring a class or brand. */
function errorCode(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("code" in value)) return null
  return value.code
}

/** Finds one original failure through an arbitrary-depth structural cause chain. */
function containsCause(value: unknown, target: Error): boolean {
  let current = value
  const visited = new Set<object>()
  while (typeof current === "object" && current !== null) {
    if (current === target) return true
    if (visited.has(current)) return false
    visited.add(current)
    try {
      if (!("cause" in current)) return false
      current = current.cause
    } catch {
      return false
    }
  }
  return false
}

/** Requires one operation to reject with the exact standard canceled singleton. */
function requireCanceled(result: Outcome, label: string): void {
  if (!result.rejected || result.value !== canceled) fail(`${label} must preserve context canceled`)
}

/** Requires one operation to reject with a stable structural transport code. */
function requireCode(result: Outcome, code: string, label: string): void {
  if (!result.rejected || errorCode(result.value) !== code) {
    fail(`${label} must reject with ${code}`)
  }
}

/** Cancels an operation only after its active invocation remains pending. */
async function cancelStarted<T>(
  parent: Context,
  operation: (ctx: Context) => T | PromiseLike<T>,
  label: string,
  onCancel: () => void = (): void => {}
): Promise<Outcome<T>> {
  const [ctx, cancel] = withCancel(parent)
  const running = invokeOutcome(() => operation(ctx))
  await crossWebTaskBoundary()
  if (!(await remainsPending(running))) {
    const completed = await running
    cancel()
    if (completed.rejected) throw completed.value
    return completed
  }
  cancel()
  onCancel()
  const canceledResult = await running
  requireCanceled(canceledResult, label)
  return canceledResult
}

/** Compares one Message against the reviewed conformance payload. */
function verifyMessage(message: Message, topic = "before", firstByte = 1): void {
  if (message.header.topic !== topic) fail("transport did not defensively copy Message headers")
  const body = message.body
  if (body.length !== 2 || body[0] !== firstByte || body[1] !== 2) {
    fail("transport did not defensively copy Message body bytes")
  }
}

/** Returns whether a terminal operation remains pending after already-queued Promise work settles. */
async function remainsPending(operation: PromiseLike<unknown>): Promise<boolean> {
  let settled = false
  /** Records either terminal outcome through one shared callable. */
  function markSettled(): void {
    settled = true
  }
  void Promise.resolve(operation).then(markSettled, markSettled)
  await Promise.resolve()
  await Promise.resolve()
  return !settled
}

/** Closes an optional client without obscuring the caller's primary assertion. */
async function closeClient(ctx: Context, client: Client | null): Promise<void> {
  if (client !== null) await client.close(ctx)
}

/** Closes an optional listener. */
async function closeListener(ctx: Context, listener: Listener | null): Promise<void> {
  if (listener !== null) await listener.close(ctx)
}

/** Consumes an optional accept terminal independently from listener close. */
async function consumeAccept(_ctx: Context, accepting: Promise<Outcome> | null): Promise<void> {
  if (accepting === null) return
  const terminal = await accepting
  if (terminal.rejected) throw terminal.value
}

/** Verifies option order, last-wins behavior, and detached readback. */
async function appliesOptions(factory: TransportFactory): Promise<void> {
  const transport = await factory()
  transport.init(timeout(1), timeout(2))
  const first = transport.options()
  const second = transport.options()
  if (first === second) fail("Transport.options must return a new defensive snapshot")
  if (first.timeoutMs !== 2) {
    fail("Transport.init must apply options in order with the last option winning")
  }
  if (!Object.isFrozen(first)) {
    fail("Transport.options must return an immutable snapshot")
  }
}

/** Verifies reviewed defaults and fail-closed provider validation of structural options. */
async function validatesOptions(factory: TransportFactory): Promise<void> {
  const transport = await factory()
  const defaults = transport.options()
  if (
    defaults.codec !== null ||
    defaults.logger !== null ||
    defaults.timeoutMs !== 0 ||
    defaults.secure ||
    defaults.tlsConfig !== null
  )
    fail("Transport.options must expose the reviewed common defaults")

  /** Produces one structural reducer whose resulting state is invalid. */
  const malformedOption: Option = (current) =>
    Object.freeze({
      codec: current.codec,
      logger: current.logger,
      timeoutMs: -1,
      secure: current.secure,
      tlsConfig: current.tlsConfig
    })
  const malformed = await invokeOutcome(() => transport.init(malformedOption))
  if (!malformed.rejected) fail("Transport.init must reject malformed structural Option output")
}

/** Verifies init leaves resources created from an earlier option snapshot usable. */
async function preservesExistingResources(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  const initialResult: unknown = transport.init(timeout(0))
  if (initialResult !== undefined) {
    fail("Transport.init must complete synchronously without returning I/O")
  }
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      const address = listener.addr()
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          const request = await socket.recv(ctx)
          await socket.send(ctx, request)
        })
      )
      client = await transport.dial(ownerCtx, address)
      const replacementResult: unknown = transport.init(timeout(1))
      if (replacementResult !== undefined) {
        fail("Transport.init must complete synchronously without returning I/O")
      }
      if (listener.addr() !== address) fail("Transport.init changed an existing listener address")
      const sending = client.send(ownerCtx, {
        header: Object.freeze({ topic: "before" }),
        body: new Uint8Array([1, 2])
      })
      await sending
      verifyMessage(await client.recv(ownerCtx))
    },
    [
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "existing resource option snapshot"
  )
}

/** Verifies pre-canceled creation Contexts reject without consuming later admission. */
async function rejectsCanceledCreation(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      const dialed = await invokeOutcome(() =>
        transport.dial(preCanceledContext(), options.listenAddress)
      )
      if (!dialed.rejected) {
        client = dialed.value
        fail("Transport.dial accepted a pre-canceled Context")
      }
      requireCanceled(dialed, "Transport.dial")

      const listened = await invokeOutcome(() =>
        transport.listen(preCanceledContext(), options.listenAddress)
      )
      if (!listened.rejected) {
        listener = listened.value
        fail("Transport.listen accepted a pre-canceled Context")
      }
      requireCanceled(listened, "Transport.listen")

      listener = await transport.listen(ownerCtx, options.listenAddress)
      const unexpectedHandler = deferred()
      accepting = outcome(listener.accept(ownerCtx, unexpectedHandler.resolve))
      client = await transport.dial(ownerCtx, listener.addr())
    },
    [
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "canceled creation admission"
  )
}

/** Verifies in-flight creation cancellation and later admission on the same Transport. */
async function cancelsStartedCreation(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      const probedListener = await cancelStarted(
        ownerCtx,
        (ctx) => transport.listen(ctx, options.listenAddress),
        "started Transport.listen"
      )
      if (!probedListener.rejected) await probedListener.value.close(ownerCtx)

      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          const request = await socket.recv(ctx)
          await socket.send(ctx, request)
        })
      )
      const activeListener = listener
      const probedClient = await cancelStarted(
        ownerCtx,
        (ctx) => transport.dial(ctx, activeListener.addr()),
        "started Transport.dial"
      )
      if (!probedClient.rejected) await probedClient.value.close(ownerCtx)

      client = await transport.dial(ownerCtx, listener.addr())
      const exchanged = await exchange(ownerCtx, client, "started-creation-health")
      if (exchanged.rejected) throw exchanged.value
      verifyMessage(exchanged.value, "started-creation-health")
    },
    [
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "started creation cancellation"
  )
}

/** Verifies bound address publication and clean close of a pending accept loop. */
async function closesPendingAccept(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      const address = listener.addr()
      if (address.length === 0) fail("Listener.addr must return a non-empty bound address")
      const unexpectedHandler = deferred()
      accepting = outcome(listener.accept(ownerCtx, unexpectedHandler.resolve))
      if (!(await remainsPending(accepting)))
        fail("Listener.accept must remain pending until a terminal event")
      await Promise.all([listener.close(ownerCtx), listener.close(ownerCtx)])
      if (await remainsPending(accepting)) {
        fail("Listener.close must not resolve before Listener.accept settles")
      }
      const terminal = await accepting
      accepting = null
      if (terminal.rejected) throw terminal.value
      await listener.close(ownerCtx)
      if (listener.addr() !== address) fail("Listener.addr changed after close")
      const repeated = await invokeOutcome(() =>
        listener?.accept(ownerCtx, unexpectedHandler.resolve)
      )
      requireCode(repeated, "GO_LIKE_TRANSPORT_STATE", "repeated Listener.accept")
    },
    [async (ctx) => closeListener(ctx, listener), async (ctx) => consumeAccept(ctx, accepting)],
    options.operationTimeoutMs,
    "pending accept close"
  )
}

/** Verifies accept cancellation and one-shot terminal state. */
async function cancelsAccept(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      const [ctx, cancel] = withCancel(background())
      const unexpectedHandler = deferred()
      accepting = outcome(listener.accept(ctx, unexpectedHandler.resolve))
      if (!(await remainsPending(accepting)))
        fail("Listener.accept settled before Context cancellation")
      cancel()
      const terminal = await accepting
      accepting = null
      requireCanceled(terminal, "Listener.accept cancellation")
      const activeListener = listener
      const repeated = await invokeOutcome(() =>
        activeListener.accept(ownerCtx, unexpectedHandler.resolve)
      )
      requireCode(repeated, "GO_LIKE_TRANSPORT_STATE", "repeated Listener.accept")
    },
    [async (ctx) => closeListener(ctx, listener), async (ctx) => consumeAccept(ctx, accepting)],
    options.operationTimeoutMs,
    "accept cancellation"
  )
}

/** Verifies pre-canceled accept admission and caller-scoped started Listener.close cleanup. */
async function scopesListenerClose(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      const activeListener = listener
      const unexpectedHandler = deferred()
      const rejected = await invokeOutcome(() =>
        activeListener.accept(preCanceledContext(), unexpectedHandler.resolve)
      )
      requireCanceled(rejected, "pre-canceled Listener.accept")
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          const request = await socket.recv(ctx)
          await socket.send(ctx, request)
        })
      )
      if (!(await remainsPending(accepting)))
        fail("pre-canceled accept consumed the one-shot Listener")

      const closing = await invokeOutcome(() => activeListener.close(preCanceledContext()))
      requireCanceled(closing, "pre-canceled Listener.close")
      await crossWebTaskBoundary()
      if (!(await remainsPending(accepting))) {
        fail("pre-canceled Listener.close must not start owner cleanup")
      }
      const dialed = await invokeOutcome(() => transport.dial(ownerCtx, activeListener.addr()))
      if (dialed.rejected) {
        throw new Error("pre-canceled Listener.close must not start owner cleanup", {
          cause: dialed.value
        })
      }
      client = dialed.value
      const healthy = await exchange(ownerCtx, client, "listener-close-health")
      if (healthy.rejected) {
        throw new Error("pre-canceled Listener.close must not start owner cleanup", {
          cause: healthy.value
        })
      }
      verifyMessage(healthy.value, "listener-close-health")

      await cancelStarted(ownerCtx, (ctx) => activeListener.close(ctx), "started Listener.close")
      const joined = await invokeOutcome(() => activeListener.close(ownerCtx))
      if (joined.rejected) {
        throw new Error("a later Listener.close caller must join owner cleanup", {
          cause: joined.value
        })
      }
      if (await remainsPending(accepting)) {
        fail("a later Listener.close must not resolve before Listener.accept settles")
      }
      const terminal = await accepting
      accepting = null
      if (terminal.rejected) throw terminal.value
    },
    [
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "listener close caller scope"
  )
}

/** Verifies socket Context admission, owner close, idempotence, and closed errors. */
async function checksSocketLifecycle(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  const message: Message = Object.freeze({
    header: Object.freeze({ topic: "before" }),
    body: new Uint8Array([1, 2])
  })
  const noHandlerFailure = Object.freeze({ state: "no-handler-failure" })
  let handlerFailure: unknown = noHandlerFailure
  const handlerChecked = deferred()
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          try {
            requireCanceled(
              await invokeOutcome(() => socket.close(preCanceledContext())),
              "pre-canceled handler Socket.close"
            )
            await crossWebTaskBoundary()
            const received = await invokeOutcome(() => socket.recv(ctx))
            if (received.rejected) {
              throw new Error("pre-canceled handler Socket.close must not close the Socket", {
                cause: received.value
              })
            }
            requireCanceled(
              await invokeOutcome(() => socket.recv(preCanceledContext())),
              "pre-canceled handler Socket.recv"
            )
            requireCanceled(
              await invokeOutcome(() => socket.send(preCanceledContext(), message)),
              "pre-canceled handler Socket.send"
            )
            const sent = await invokeOutcome(() => socket.send(ctx, received.value))
            if (sent.rejected) {
              throw new Error("pre-canceled handler Socket.close must not close the Socket", {
                cause: sent.value
              })
            }
            await socket.close(ownerCtx)
            requireCode(
              await invokeOutcome(() => socket.recv(ownerCtx)),
              "GO_LIKE_TRANSPORT_CLOSED",
              "closed handler Socket.recv"
            )
            requireCode(
              await invokeOutcome(() => socket.send(ownerCtx, received.value)),
              "GO_LIKE_TRANSPORT_CLOSED",
              "closed handler Socket.send"
            )
            await Promise.all([socket.close(ownerCtx), socket.close(ownerCtx)])
          } catch (failure) {
            handlerFailure = failure
            throw failure
          } finally {
            handlerChecked.resolve()
          }
        })
      )
      client = await transport.dial(ownerCtx, listener.addr())
      const activeClient = client
      requireCanceled(
        await invokeOutcome(() => activeClient.send(preCanceledContext(), message)),
        "pre-canceled Socket.send"
      )
      requireCanceled(
        await invokeOutcome(() => activeClient.recv(preCanceledContext())),
        "pre-canceled Socket.recv"
      )
      requireCanceled(
        await invokeOutcome(() => activeClient.close(preCanceledContext())),
        "pre-canceled Socket.close"
      )
      await crossWebTaskBoundary()
      const sending = outcome(client.send(ownerCtx, message))
      const sent = await sending
      if (sent.rejected) {
        await crossWebTaskBoundary()
        if (handlerFailure === noHandlerFailure) await crossWebTaskBoundary()
        if (handlerFailure !== noHandlerFailure) throw handlerFailure
        throw new Error("pre-canceled Socket.close must not close the Client", {
          cause: sent.value
        })
      }
      await handlerChecked.promise
      if (handlerFailure !== noHandlerFailure) throw handlerFailure
      const received = await invokeOutcome(() => activeClient.recv(ownerCtx))
      if (received.rejected) {
        throw new Error("pre-canceled Socket.close must not close the Client", {
          cause: received.value
        })
      }
      verifyMessage(received.value)

      await client.close(ownerCtx)
      requireCode(
        await invokeOutcome(() => activeClient.send(ownerCtx, message)),
        "GO_LIKE_TRANSPORT_CLOSED",
        "closed Socket.send"
      )
      requireCode(
        await invokeOutcome(() => activeClient.recv(ownerCtx)),
        "GO_LIKE_TRANSPORT_CLOSED",
        "closed Socket.recv"
      )
      await Promise.all([client.close(ownerCtx), client.close(ownerCtx)])
    },
    [
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "socket lifecycle"
  )
}

/** Verifies in-flight client and handler cancellation without closing unrelated ownership. */
async function cancelsStartedSockets(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let accepting: Promise<Outcome> | null = null
  const clientSendRelease = deferred()
  const clientRecvStarted = deferred()
  const clientRecvRelease = deferred()
  const handlerRecvChecked = deferred()
  const handlerSendChecked = deferred()
  const handlerCloseChecked = deferred()
  const noHandlerFailure = Object.freeze({ state: "no-handler-failure" })
  let handlerFailure: unknown = noHandlerFailure
  let handlerStage: "routing" | "recv" | "send" | "close" = "routing"
  let handlerRecvCanceled = false
  let handlerSendCanceled = false
  const cleanups: Cleanup[] = [
    () => {
      clientSendRelease.resolve()
    },
    () => {
      clientRecvRelease.resolve()
    },
    async (ctx) => closeListener(ctx, listener),
    async (ctx) => consumeAccept(ctx, accepting)
  ]

  /** Registers each admitted client as its own independently bounded cleanup. */
  function retainClient(client: Client): Client {
    cleanups.splice(cleanups.length - 2, 0, async (ctx) => client.close(ctx))
    return client
  }

  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          const stage = handlerStage
          let action = `handler ${stage} operation`
          try {
            if (stage === "recv") {
              const received = await cancelStarted(
                ctx,
                (operationCtx) => socket.recv(operationCtx),
                "started handler Socket.recv"
              )
              handlerRecvCanceled = received.rejected
              if (!received.rejected) {
                action = "handler recv follow-up response"
                await socket.send(ctx, received.value)
              }
              return
            }

            const request = await socket.recv(ctx)
            if (stage === "send") {
              const sent = await cancelStarted(
                ctx,
                (operationCtx) => socket.send(operationCtx, request),
                "started handler Socket.send"
              )
              handlerSendCanceled = sent.rejected
              return
            }
            if (stage === "close") {
              await cancelStarted(
                ctx,
                (operationCtx) => socket.close(operationCtx),
                "started handler Socket.close"
              )
              return
            }
            if (request.header.topic === "client-send-cancel") {
              await clientSendRelease.promise
            }
            if (request.header.topic === "client-recv-cancel") {
              clientRecvStarted.resolve()
              await clientRecvRelease.promise
            }
            await socket.send(ctx, request)
          } catch (failure) {
            if (stage !== "routing") {
              handlerFailure = new Error(`${action} failed`, { cause: failure })
            }
            throw failure
          } finally {
            if (stage === "recv") handlerRecvChecked.resolve()
            if (stage === "send") handlerSendChecked.resolve()
            if (stage === "close") handlerCloseChecked.resolve()
          }
        })
      )

      const sendClient = retainClient(await transport.dial(ownerCtx, listener.addr()))
      await cancelStarted(
        ownerCtx,
        (ctx) =>
          sendClient.send(ctx, {
            header: Object.freeze({ topic: "client-send-cancel" }),
            body: new Uint8Array([1, 2])
          }),
        "started client Socket.send",
        clientSendRelease.resolve
      )
      const sendHealth = await exchange(ownerCtx, sendClient, "client-send-health")
      if (sendHealth.rejected) {
        throw new Error("client Socket.send cancellation closed its owning client", {
          cause: sendHealth.value
        })
      }
      verifyMessage(sendHealth.value, "client-send-health")

      const recvClient = retainClient(await transport.dial(ownerCtx, listener.addr()))
      const sendingForRecv = outcome(
        recvClient.send(ownerCtx, {
          header: Object.freeze({ topic: "client-recv-cancel" }),
          body: new Uint8Array([1, 2])
        })
      )
      await clientRecvStarted.promise
      await cancelStarted(
        ownerCtx,
        (ctx) => recvClient.recv(ctx),
        "started client Socket.recv",
        clientRecvRelease.resolve
      )
      const sendAfterRecvCancel = await sendingForRecv
      if (
        sendAfterRecvCancel.rejected &&
        sendAfterRecvCancel.value !== canceled &&
        errorCode(sendAfterRecvCancel.value) !== "GO_LIKE_TRANSPORT_CLOSED"
      )
        fail("client Socket.send after recv cancellation returned an unrelated failure")
      const recvHealth = await exchange(ownerCtx, recvClient, "client-recv-health")
      if (recvHealth.rejected) {
        throw new Error("client Socket.recv cancellation closed its owning client", {
          cause: recvHealth.value
        })
      }
      verifyMessage(recvHealth.value, "client-recv-health")

      const closeClientProbe = retainClient(await transport.dial(ownerCtx, listener.addr()))
      await cancelStarted(
        ownerCtx,
        (ctx) => closeClientProbe.close(ctx),
        "started client Socket.close"
      )

      handlerStage = "recv"
      const handlerRecvClient = retainClient(await transport.dial(ownerCtx, listener.addr()))
      const handlerRecvSending = outcome(
        handlerRecvClient.send(ownerCtx, {
          header: Object.freeze({ topic: "handler-recv-cancel" }),
          body: new Uint8Array([1, 2])
        })
      )
      await handlerRecvChecked.promise
      if (handlerFailure !== noHandlerFailure) {
        throw new Error("started handler Socket.recv failed conformance", { cause: handlerFailure })
      }
      const handlerRecvSent = await handlerRecvSending
      if (!handlerRecvCanceled) {
        if (handlerRecvSent.rejected) {
          throw new Error("completed handler Socket.recv did not preserve its response", {
            cause: handlerRecvSent.value
          })
        }
        verifyMessage(await handlerRecvClient.recv(ownerCtx), "handler-recv-cancel")
      }

      handlerStage = "send"
      const handlerSendClient = retainClient(await transport.dial(ownerCtx, listener.addr()))
      const handlerSendSending = outcome(
        handlerSendClient.send(ownerCtx, {
          header: Object.freeze({ topic: "handler-send-cancel" }),
          body: new Uint8Array([1, 2])
        })
      )
      await handlerSendChecked.promise
      if (handlerFailure !== noHandlerFailure) {
        throw new Error("started handler Socket.send failed conformance", { cause: handlerFailure })
      }
      const handlerSent = await handlerSendSending
      if (!handlerSendCanceled) {
        if (handlerSent.rejected) {
          throw new Error("completed handler Socket.send did not preserve its response", {
            cause: handlerSent.value
          })
        }
        verifyMessage(await handlerSendClient.recv(ownerCtx), "handler-send-cancel")
      }

      handlerStage = "close"
      const handlerCloseClient = retainClient(await transport.dial(ownerCtx, listener.addr()))
      const handlerCloseSending = outcome(
        handlerCloseClient.send(ownerCtx, {
          header: Object.freeze({ topic: "handler-close-cancel" }),
          body: new Uint8Array([1, 2])
        })
      )
      await handlerCloseChecked.promise
      if (handlerFailure !== noHandlerFailure) {
        throw new Error("started handler Socket.close failed conformance", {
          cause: handlerFailure
        })
      }
      await handlerCloseSending

      handlerStage = "routing"
      const healthClient = retainClient(await transport.dial(ownerCtx, listener.addr()))
      const health = await exchange(ownerCtx, healthClient, "started-socket-health")
      if (health.rejected) {
        if (accepting !== null && !(await remainsPending(accepting))) {
          await accepting
          accepting = null
        }
        throw new Error("handler Socket cancellation closed its unrelated listener", {
          cause: health.value
        })
      }
      verifyMessage(health.value, "started-socket-health")
    },
    cleanups,
    options.operationTimeoutMs,
    "started Socket cancellation"
  )
}

/** Waits for one Context to terminate and returns its exact terminal error. */
async function waitContext(ctx: Context): Promise<unknown> {
  const signal = ctx.done()
  if (signal === null) fail("handler Context must expose a cancellation signal")
  if (ctx.err() === null) {
    await new Promise<void>((resolve) => {
      /** Resolves the handler wait when its Context terminates. */
      function onAbort(): void {
        resolve()
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
  return ctx.err()
}

/** Verifies handler Context derivation and cancellation by accept termination. */
async function cancelsHandlerWithAccept(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  let sending: Promise<Outcome> | null = null
  let handlerContext: Context = background()
  const noHandlerFailure = Object.freeze({ state: "no-handler-failure" })
  let handlerFailure: unknown = noHandlerFailure
  const started = deferred()
  const stopped = deferred()
  const handlerTimeoutMs = Math.max(60_000, Math.min(options.operationTimeoutMs * 2, 2_147_483_647))
  /** Holds the accept-owned child canceler after scenario admission. */
  let cancelAccept: (() => void) | null = null
  const valueKey = Object.freeze({ key: "handler-context" })
  const value = Object.freeze({ value: "preserved" })
  await withCleanup(
    async (ownerCtx) => {
      const [acceptCtx, cancel] = withTimeout(ownerCtx, handlerTimeoutMs)
      cancelAccept = cancel
      const valuedAcceptCtx = withValue(acceptCtx, valueKey, value)
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(valuedAcceptCtx, async (ctx, socket) => {
          try {
            handlerContext = ctx
            await socket.recv(ctx)
            started.resolve()
            const failure = await waitContext(ctx)
            if (failure !== canceled) fail("accept termination must cancel the handler Context")
          } catch (failure) {
            handlerFailure = failure
            throw failure
          } finally {
            stopped.resolve()
          }
        })
      )
      client = await transport.dial(ownerCtx, listener.addr())
      sending = outcome(
        client.send(ownerCtx, {
          header: Object.freeze({ topic: "cancel-accept" }),
          body: new Uint8Array([1, 2])
        })
      )
      await started.promise
      const observedContext = handlerContext
      if (observedContext === valuedAcceptCtx)
        fail("AcceptHandler Context must be derived, not reused")
      if (observedContext.value(valueKey) !== value) {
        fail("handler Context must preserve accept Context values")
      }
      const [expectedDeadline, expectedHasDeadline] = valuedAcceptCtx.deadline()
      const [observedDeadline, observedHasDeadline] = observedContext.deadline()
      if (
        !expectedHasDeadline ||
        !observedHasDeadline ||
        expectedDeadline.getTime() !== observedDeadline.getTime()
      )
        fail("handler Context must preserve the accept Context deadline")
      cancelAccept()
      const terminal = await accepting
      accepting = null
      requireCanceled(terminal, "handler-owning Listener.accept")
      await stopped.promise
      if (handlerFailure !== noHandlerFailure) throw handlerFailure
      await sending
    },
    [
      async () => {
        cancelAccept?.()
        if (accepting !== null) {
          const terminal = await accepting
          accepting = null
          requireCanceled(terminal, "handler-owning Listener.accept cleanup")
        }
      },
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting),
      async () => {
        if (sending !== null) await sending
      }
    ],
    options.operationTimeoutMs,
    "handler accept Context"
  )
}

/** Runs one handler-cancellation probe for listener or socket termination. */
async function handlerTerminationProbe(
  transport: Transport,
  options: SnapshotConformanceOptions,
  source: "listener" | "socket"
): Promise<void> {
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  let sending: Promise<Outcome> | null = null
  const noHandlerFailure = Object.freeze({ state: "no-handler-failure" })
  let handlerFailure: unknown = noHandlerFailure
  const started = deferred()
  const stopped = deferred()
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          try {
            await socket.recv(ctx)
            started.resolve()
            if (source === "socket") await socket.close(ownerCtx)
            const failure = await waitContext(ctx)
            if (failure !== canceled) fail(`${source} termination must cancel the handler Context`)
          } catch (failure) {
            handlerFailure = failure
            throw failure
          } finally {
            stopped.resolve()
          }
        })
      )
      client = await transport.dial(ownerCtx, listener.addr())
      sending = outcome(
        client.send(ownerCtx, {
          header: Object.freeze({ topic: source }),
          body: new Uint8Array([1, 2])
        })
      )
      await started.promise
      if (source === "listener") await listener.close(ownerCtx)
      await stopped.promise
      if (handlerFailure !== noHandlerFailure) throw handlerFailure
      await sending
    },
    [
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting),
      async () => {
        if (sending !== null) await sending
      }
    ],
    options.operationTimeoutMs,
    `${source} handler termination`
  )
}

/** Verifies listener and socket termination both cancel per-handler Contexts. */
async function cancelsHandlerWithOwnedTermination(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  await handlerTerminationProbe(transport, options, "listener")
  await handlerTerminationProbe(transport, options, "socket")
}

/** Verifies recv-before-send state and FIFO pairing by send invocation order. */
async function preservesSocketOrder(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  const releaseFirst = deferred()
  const secondStarted = deferred()
  const secondCompleted = deferred()
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          const request = await socket.recv(ctx)
          if (request.header.topic === "first") await releaseFirst.promise
          if (request.header.topic === "second") secondStarted.resolve()
          await socket.send(ctx, request)
          if (request.header.topic === "second") secondCompleted.resolve()
        })
      )
      client = await transport.dial(ownerCtx, listener.addr())
      const activeClient = client
      requireCode(
        await invokeOutcome(() => activeClient.recv(ownerCtx)),
        "GO_LIKE_TRANSPORT_STATE",
        "recv before send"
      )
      const firstSend = client.send(ownerCtx, {
        header: Object.freeze({ topic: "first" }),
        body: new Uint8Array([1, 2])
      })
      const secondSend = client.send(ownerCtx, {
        header: Object.freeze({ topic: "second" }),
        body: new Uint8Array([2, 2])
      })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      const concurrent = !(await remainsPending(secondStarted.promise))
      if (concurrent) await secondCompleted.promise
      releaseFirst.resolve()
      await Promise.all([firstSend, secondSend])
      verifyMessage(await client.recv(ownerCtx), "first", 1)
      verifyMessage(await client.recv(ownerCtx), "second", 2)
    },
    [
      () => {
        releaseFirst.resolve()
      },
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "socket invocation order"
  )
}

/** Completes one send/recv pair and exposes either phase failure as one Outcome. */
async function exchange(ctx: Context, client: Client, topic: string): Promise<Outcome<Message>> {
  const sent = await invokeOutcome(() =>
    client.send(ctx, {
      header: Object.freeze({ topic }),
      body: new Uint8Array([1, 2])
    })
  )
  if (sent.rejected) return sent
  return await invokeOutcome(() => client.recv(ctx))
}

/** Verifies handler concurrency and isolation after one handler rejection. */
async function isolatesHandlerFailure(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let first: Client | null = null
  let second: Client | null = null
  let third: Client | null = null
  let accepting: Promise<Outcome> | null = null
  const bothStarted = deferred()
  let active = 0
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          const request = await socket.recv(ctx)
          active += 1
          if (active === 2) bothStarted.resolve()
          await bothStarted.promise
          active -= 1
          if (request.header.topic === "failure")
            throw new Error("expected isolated handler failure")
          await socket.send(ctx, request)
        })
      )
      first = await transport.dial(ownerCtx, listener.addr())
      second = await transport.dial(ownerCtx, listener.addr())
      const failed = exchange(ownerCtx, first, "failure")
      const succeeded = exchange(ownerCtx, second, "success")
      const failedResult = await failed
      if (!failedResult.rejected) fail("a rejecting handler must fail only its own exchange")
      const successResult = await succeeded
      if (successResult.rejected) throw successResult.value
      verifyMessage(successResult.value, "success")
      if (!(await remainsPending(accepting))) fail("one handler failure terminated the accept loop")

      third = await transport.dial(ownerCtx, listener.addr())
      const later = await exchange(ownerCtx, third, "later")
      if (later.rejected) throw later.value
      verifyMessage(later.value, "later")
    },
    [
      async (ctx) => closeClient(ctx, third),
      async (ctx) => closeClient(ctx, second),
      async (ctx) => closeClient(ctx, first),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "handler failure isolation"
  )
}

/** Verifies both send and receive sides detach Message headers and body bytes. */
async function exchangesMessage(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let client: Client | null = null
  let accepting: Promise<Outcome> | null = null
  let sending: Promise<Outcome<void>> | null = null
  const received = deferred()
  const release = deferred()
  const handlerChecked = deferred()
  const noHandlerFailure = Object.freeze({ state: "no-handler-failure" })
  let handlerFailure: unknown = noHandlerFailure
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      accepting = outcome(
        listener.accept(ownerCtx, async (ctx, socket) => {
          try {
            const request = await socket.recv(ctx)
            verifyMessage(request)
            const exposedRequestBody = request.body
            exposedRequestBody[0] = 88
            verifyMessage(request)
            received.resolve()
            await release.promise
            const responseHeader = { topic: "response" }
            const responseBody = new Uint8Array([3, 2])
            const responding = socket.send(ctx, { header: responseHeader, body: responseBody })
            responseHeader.topic = "mutated"
            responseBody[0] = 99
            await responding
          } catch (failure) {
            handlerFailure = failure
            throw failure
          } finally {
            handlerChecked.resolve()
          }
        })
      )
      client = await transport.dial(ownerCtx, listener.addr())
      const header = { topic: "before" }
      const body = new Uint8Array([1, 2])
      sending = outcome(client.send(ownerCtx, { header, body }))
      header.topic = "after"
      body[0] = 99
      await Promise.race([received.promise, handlerChecked.promise])
      if (handlerFailure !== noHandlerFailure) throw handlerFailure
      release.resolve()
      const sent = await sending
      if (sent.rejected) throw sent.value
      const response = await client.recv(ownerCtx)
      verifyMessage(response, "response", 3)
      if (!Object.isFrozen(response.header)) fail("received Message header must be frozen")
      const exposed = response.body
      exposed[0] = 77
      verifyMessage(response, "response", 3)
    },
    [
      () => {
        release.resolve()
      },
      async () => {
        if (sending !== null) await sending
      },
      async (ctx) => closeClient(ctx, client),
      async (ctx) => closeListener(ctx, listener),
      async (ctx) => consumeAccept(ctx, accepting)
    ],
    options.operationTimeoutMs,
    "Message defensive copy"
  )
}

/** Verifies an injected provider host failure reaches accept with original cause. */
async function preservesHostFailure(
  factory: TransportFactory,
  options: SnapshotConformanceOptions,
  harness: TransportConformanceFaultHarness
): Promise<void> {
  const transport = await factory()
  let listener: Listener | null = null
  let accepting: Promise<Outcome> | null = null
  await withCleanup(
    async (ownerCtx) => {
      listener = await transport.listen(ownerCtx, options.listenAddress)
      const unexpectedHandler = deferred()
      accepting = outcome(listener.accept(ownerCtx, unexpectedHandler.resolve))
      const cause = new Error("injected unexpected listener failure")
      await harness.failListener(ownerCtx, listener, cause)
      const terminal = await accepting
      accepting = null
      if (!terminal.rejected) fail("unexpected listener failure must reject Listener.accept")
      if (!containsCause(terminal.value, cause)) {
        fail("unexpected listener failure must preserve its original cause")
      }
    },
    [async (ctx) => closeListener(ctx, listener), async (ctx) => consumeAccept(ctx, accepting)],
    options.operationTimeoutMs,
    "unexpected listener failure"
  )
}

/** Narrows one structural fault injection callable. */
function isFaultCallable(
  value: unknown
): value is TransportConformanceFaultHarness["failListener"] {
  return typeof value === "function"
}

/** Snapshots one borrowed fault harness without retaining a mutable method lookup. */
function snapshotFaultHarness(value: unknown): TransportConformanceFaultHarness | null {
  if (value === null) return null
  if (typeof value !== "object") {
    throw new TypeError("transport conformance faultHarness must be an object or null")
  }
  const failListener: unknown = Reflect.get(value, "failListener")
  if (!isFaultCallable(failListener)) {
    throw new TypeError("transport conformance faultHarness must be an object or null")
  }
  return Object.freeze({
    /** Delegates one fault injection through the snapshotted structural callable. */
    failListener(ctx: Context, listener: Listener, cause: Error): void | PromiseLike<void> {
      return failListener.call(value, ctx, listener, cause)
    }
  })
}

/** Validates and freezes the complete conformance configuration. */
function snapshotConformanceOptions(
  options: TransportConformanceOptions
): SnapshotConformanceOptions {
  const candidate: unknown = options
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("transport conformance options must be an object")
  }
  const listenAddress: unknown =
    "listenAddress" in candidate ? Reflect.get(candidate, "listenAddress") : undefined
  if (typeof listenAddress !== "string" || listenAddress.length === 0) {
    throw new TypeError("transport conformance listenAddress must be a non-empty string")
  }
  if (!("faultHarness" in candidate)) {
    throw new TypeError("transport conformance faultHarness must be an object or null")
  }
  const faultHarness: unknown = Reflect.get(candidate, "faultHarness")
  const requestedTimeout =
    "operationTimeoutMs" in candidate
      ? Reflect.get(candidate, "operationTimeoutMs")
      : DefaultConformanceTimeoutMs
  if (
    !Number.isSafeInteger(requestedTimeout) ||
    typeof requestedTimeout !== "number" ||
    requestedTimeout <= 0
  ) {
    throw new RangeError("transport conformance operationTimeoutMs must be a positive safe integer")
  }
  return Object.freeze({
    listenAddress,
    faultHarness: snapshotFaultHarness(faultHarness),
    operationTimeoutMs: requestedTimeout
  })
}

/** Builds isolated, runner-neutral black-box cases for the public Transport contract. */
export function transportConformanceCases(
  factory: TransportFactory,
  options: TransportConformanceOptions
): readonly TransportConformanceCase[] {
  const snapshot = snapshotConformanceOptions(options)
  const cases: TransportConformanceCase[] = [
    Object.freeze({
      name: "transport applies options in order and returns defensive snapshots",
      /** Runs immutable option ordering and readback assertions. */
      run: async () => appliesOptions(factory)
    }),
    Object.freeze({
      name: "transport exposes defaults and rejects invalid public options",
      /** Runs common default and public option validation assertions. */
      run: async () => validatesOptions(factory)
    }),
    Object.freeze({
      name: "transport init preserves resources created from an earlier option snapshot",
      /** Runs configuration-only init assertions against an existing round trip. */
      run: async () => preservesExistingResources(factory, snapshot)
    }),
    Object.freeze({
      name: "pre-canceled dial and listen stop before resource admission",
      /** Runs pre-canceled creation admission assertions. */
      run: async () => rejectsCanceledCreation(factory, snapshot)
    }),
    Object.freeze({
      name: "started dial and listen cancellation preserves identity and later admission",
      /** Runs in-flight creation cancellation and later-admission assertions. */
      run: async () => cancelsStartedCreation(factory, snapshot)
    }),
    Object.freeze({
      name: "listener exposes its bound address and closes a pending accept",
      /** Runs listener address and clean-close assertions. */
      run: async () => closesPendingAccept(factory, snapshot)
    }),
    Object.freeze({
      name: "accept cancellation preserves the Context terminal error",
      /** Runs accept cancellation and one-shot assertions. */
      run: async () => cancelsAccept(factory, snapshot)
    }),
    Object.freeze({
      name: "pre-canceled accept remains reusable and pre-canceled or started close is caller-scoped",
      /** Runs accept admission and owner cleanup assertions. */
      run: async () => scopesListenerClose(factory, snapshot)
    }),
    Object.freeze({
      name: "socket Context admission, close ownership, and closed errors are stable",
      /** Runs socket Context and close-state assertions. */
      run: async () => checksSocketLifecycle(factory, snapshot)
    }),
    Object.freeze({
      name: "started client and handler Socket cancellation preserves identity and ownership",
      /** Runs in-flight Socket cancellation and unrelated-owner assertions. */
      run: async () => cancelsStartedSockets(factory, snapshot)
    }),
    Object.freeze({
      name: "handler Context is derived and canceled by accept termination",
      /** Runs accept-owned handler Context assertions. */
      run: async () => cancelsHandlerWithAccept(factory, snapshot)
    }),
    Object.freeze({
      name: "handler Context is canceled by listener and socket termination",
      /** Runs listener- and socket-owned handler Context assertions. */
      run: async () => cancelsHandlerWithOwnedTermination(factory, snapshot)
    }),
    Object.freeze({
      name: "socket rejects recv-before-send and preserves invocation order",
      /** Runs socket state and FIFO pairing assertions. */
      run: async () => preservesSocketOrder(factory, snapshot)
    }),
    Object.freeze({
      name: "concurrent handlers isolate one handler failure",
      /** Runs concurrent dispatch and failure-isolation assertions. */
      run: async () => isolatesHandlerFailure(factory, snapshot)
    }),
    Object.freeze({
      name: "client and listener exchange a defensively copied Message",
      /** Runs bidirectional Message-copy assertions. */
      run: async () => exchangesMessage(factory, snapshot)
    })
  ]
  const faultHarness = snapshot.faultHarness
  if (faultHarness !== null) {
    cases.push(
      Object.freeze({
        name: "unexpected listener failure preserves its original cause",
        /** Runs optional real provider failure-injection assertions. */
        run: async () => preservesHostFailure(factory, snapshot, faultHarness)
      })
    )
  }
  return Object.freeze(cases)
}
