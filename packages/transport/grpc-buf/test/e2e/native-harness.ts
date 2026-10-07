import { background, canceled, withCancel, type Context } from "@go-like/context"
import type { SelectionOutcome, Selector } from "@go-like/registry"
import {
  address,
  newClient,
  newServer,
  withEndpoint,
  withSelector,
  type Client,
  type Server,
  type ServerOption
} from "@go-like/transport-grpc-buf/native"

import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceHandler
} from "../../.artifacts/gen/order/v1/order_like.js"

import { runManagedFaultTests } from "./native-faults.js"

export interface NativeRuntimeIdentity {
  readonly runtime: "bun" | "deno" | "node"
  readonly version: string
}

export interface NativeCounters {
  unary: number
  serverStreaming: number
  clientStreaming: number
  bidi: number
}

export interface NativeCardinalityResult {
  readonly unary: { readonly id: string; readonly state: string }
  readonly serverStreaming: readonly {
    readonly orderId: string
    readonly type: string
    readonly sequence: number
  }[]
  readonly clientStreaming: { readonly count: number }
  readonly bidi: readonly {
    readonly orderId: string
    readonly type: string
    readonly sequence: number
  }[]
}

export interface ManagedServerOwner {
  readonly endpoint: string
  readonly counters: NativeCounters
  readonly running: Promise<void>
  stop(ctx?: Context): Promise<void>
}

const ExpectedResult: NativeCardinalityResult = Object.freeze({
  unary: { id: "managed-order", state: "READY" },
  serverStreaming: [
    { orderId: "managed-customer-1", type: "CREATED", sequence: 1 },
    { orderId: "managed-customer-2", type: "READY", sequence: 2 }
  ],
  clientStreaming: { count: 3 },
  bidi: [
    { orderId: "sync-1", type: "ACK:CREATE", sequence: 1 },
    { orderId: "sync-2", type: "ACK:SHIP", sequence: 2 }
  ]
})

function combine(primary: unknown, cleanup: readonly unknown[], message: string): never {
  if (cleanup.length === 0) throw primary
  throw new AggregateError([primary, ...cleanup], message)
}

async function stopServer(server: Server, running: Promise<void>): Promise<void> {
  const results = await Promise.allSettled([server.stop(background()), running])
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "managed gRPC server cleanup failed")
}

function service(counters: NativeCounters): OrderServiceHandler {
  return {
    getOrder(_ctx, request) {
      counters.unary += 1
      return { id: request.id, state: "READY" }
    },
    delete$(_ctx, request) {
      return { id: request.id, state: "DELETED" }
    },
    async *watchOrders(_ctx, request) {
      counters.serverStreaming += 1
      yield { orderId: `${request.customerId}-1`, type: "CREATED", sequence: 1 }
      yield { orderId: `${request.customerId}-2`, type: "READY", sequence: 2 }
    },
    async uploadEvents(_ctx, requests) {
      counters.clientStreaming += 1
      let count = 0
      for await (const _request of requests) count += 1
      return { count }
    },
    async *syncOrders(_ctx, requests) {
      counters.bidi += 1
      let sequence = 0
      for await (const request of requests) {
        sequence += 1
        yield {
          orderId: request.orderId,
          type: `ACK:${request.action}`,
          sequence
        }
      }
    }
  }
}

async function bindManagedServer(
  counters: NativeCounters,
  handler: OrderServiceHandler,
  options: readonly ServerOption[]
): Promise<ManagedServerOwner> {
  const server = newServer(address("127.0.0.1:0"), ...options)
  registerOrderServiceHandler(server, handler)
  const running = server.start(background())
  void running.catch(() => {})
  let stopping: Promise<void> | null = null
  const stop = (ctx?: Context): Promise<void> =>
    ctx === undefined ? (stopping ??= stopServer(server, running)) : server.stop(ctx)
  try {
    return Object.freeze({
      endpoint: await server.endpoint(background()),
      counters,
      running,
      stop
    })
  } catch (error) {
    try {
      await stop()
    } catch (cleanupError) {
      combine(error, [cleanupError], "managed gRPC server bind and cleanup failed")
    }
    throw error
  }
}

export async function startManagedServer(
  ...options: readonly ServerOption[]
): Promise<ManagedServerOwner> {
  const counters: NativeCounters = {
    unary: 0,
    serverStreaming: 0,
    clientStreaming: 0,
    bidi: 0
  }
  return await bindManagedServer(counters, service(counters), options)
}

async function* uploadEvents() {
  yield { orderId: "upload-1", type: "CREATED" }
  yield { orderId: "upload-2", type: "PAID" }
  yield { orderId: "upload-3", type: "SHIPPED" }
}

async function* syncCommands() {
  yield { orderId: "sync-1", action: "CREATE" }
  yield { orderId: "sync-2", action: "SHIP" }
}

async function exercise(client: Client): Promise<NativeCardinalityResult> {
  const orders = newOrderServiceClient(client)
  const unary = await orders.getOrder(background(), { id: "managed-order" })
  const serverStreaming = []
  for await (const event of orders.watchOrders(background(), {
    customerId: "managed-customer"
  })) {
    serverStreaming.push({
      orderId: event.orderId,
      type: event.type,
      sequence: event.sequence
    })
  }
  const clientStreaming = await orders.uploadEvents(background(), uploadEvents())
  const bidi = []
  for await (const event of orders.syncOrders(background(), syncCommands())) {
    bidi.push({ orderId: event.orderId, type: event.type, sequence: event.sequence })
  }
  return {
    unary: { id: unary.id, state: unary.state },
    serverStreaming,
    clientStreaming: { count: clientStreaming.count },
    bidi
  }
}

function isCanonicalCanceled(value: unknown): value is Error {
  return (
    value === canceled &&
    value instanceof Error &&
    value.name === "Canceled" &&
    value.message === "context canceled"
  )
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | Promise<T>): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"]
  let reject!: Deferred<T>["reject"]
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded 5 seconds`)), 5_000)
      })
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function rejectedWithin(operation: Promise<unknown>, label: string): Promise<unknown> {
  return await within(
    operation.then(
      () => {
        throw new Error(`${label} unexpectedly fulfilled`)
      },
      (error: unknown) => error
    ),
    label
  )
}

function observeCancellation(ctx: Context, observed: Deferred<Error>): Promise<void> {
  const signal = ctx.done()
  if (signal === null) throw new Error("native lifecycle handler Context must be cancelable")
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      const error = ctx.err()
      if (error === null) {
        const failure = new Error("native lifecycle handler signal aborted without Context error")
        observed.reject(failure)
        reject(failure)
        return
      }
      observed.resolve(error)
      resolve()
    }
    if (signal.aborted) finish()
    else signal.addEventListener("abort", finish, { once: true })
  })
}

async function* heldCommand(orderId: string, gate: Promise<void>) {
  yield { orderId, action: "CREATE" }
  await gate
}

async function runManagedLifecycleTest(identity: NativeRuntimeIdentity) {
  const watchObserved = deferred<Error>()
  const bidiObserved = deferred<Error>()
  const forcedObserved = deferred<Error>()
  const watchPending = deferred<void>()
  const bidiPending = deferred<void>()
  const watchFinished = deferred<void>()
  const bidiFinished = deferred<void>()
  const forcedFinished = deferred<void>()
  const handlerFinally = { serverStreaming: 0, bidi: 0, forcedBidi: 0 }
  for (const observed of [watchObserved, bidiObserved, forcedObserved]) {
    void observed.promise.catch(() => {})
  }
  const counters: NativeCounters = {
    unary: 0,
    serverStreaming: 0,
    clientStreaming: 0,
    bidi: 0
  }
  const handler: OrderServiceHandler = {
    getOrder(_ctx, request) {
      counters.unary += 1
      return { id: request.id, state: "READY" }
    },
    delete$(_ctx, request) {
      return { id: request.id, state: "DELETED" }
    },
    async *watchOrders(ctx, request) {
      counters.serverStreaming += 1
      const cancellation = observeCancellation(ctx, watchObserved)
      try {
        yield { orderId: `${request.customerId}-1`, type: "CREATED", sequence: 1 }
        watchPending.resolve()
        await cancellation
      } finally {
        handlerFinally.serverStreaming += 1
        watchFinished.resolve()
      }
    },
    async uploadEvents(_ctx, requests) {
      counters.clientStreaming += 1
      let count = 0
      for await (const _request of requests) count += 1
      return { count }
    },
    async *syncOrders(ctx, requests) {
      counters.bidi += 1
      const first = await requests[Symbol.asyncIterator]().next()
      if (first.done === true) throw new Error("native lifecycle bidi requires one command")
      const observed = first.value.orderId === "force-bidi" ? forcedObserved : bidiObserved
      const cancellation = observeCancellation(ctx, observed)
      try {
        yield {
          orderId: first.value.orderId,
          type: `ACK:${first.value.action}`,
          sequence: 1
        }
        if (observed === bidiObserved) bidiPending.resolve()
        await cancellation
      } finally {
        if (observed === bidiObserved) {
          handlerFinally.bidi += 1
          bidiFinished.resolve()
        } else {
          handlerFinally.forcedBidi += 1
          forcedFinished.resolve()
        }
      }
    }
  }
  const owner = await bindManagedServer(counters, handler, [])
  const completions: number[] = []
  const completionErrors: (Error | null)[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) {
        throw new Error("native lifecycle selector requires one endpoint")
      }
      const slot = completions.push(0) - 1
      return [
        { instance, url },
        (_feedbackCtx, outcome: SelectionOutcome) => {
          completions[slot] = (completions[slot] ?? 0) + 1
          completionErrors[slot] = outcome.error
        }
      ]
    }
  }
  const client = newClient(withEndpoint(owner.endpoint), withSelector(selector))
  const orders = newOrderServiceClient(client)
  const bidiGate = deferred<void>()
  const forcedGate = deferred<void>()
  let cancelWatch: (() => void) | null = null
  let cancelBidi: (() => void) | null = null
  let primary: unknown = null
  let evidence: {
    readonly servers: 1
    readonly serverStreaming: { readonly nextCanonical: true; readonly handlerCanonical: true }
    readonly bidi: { readonly nextCanonical: true; readonly handlerCanonical: true }
    readonly forcedStop: {
      readonly waiterCanonical: true
      readonly activeNextRejected: true
      readonly handlerCanonical: true
      readonly backgroundStop: true
      readonly running: true
    }
    readonly selectionCompletions: readonly [1, 1, 1]
    readonly handlerFinally: typeof handlerFinally
    readonly cleanup: { readonly client: true; readonly server: true; readonly running: true }
  } | null = null

  try {
    const watchContext = withCancel(background())
    cancelWatch = watchContext[1]
    const watch = orders
      .watchOrders(watchContext[0], { customerId: "cancel-watch" })
      [Symbol.asyncIterator]()
    const firstWatch = await within(watch.next(), `${identity.runtime} first server stream read`)
    if (firstWatch.done === true || firstWatch.value.orderId !== "cancel-watch-1") {
      throw new Error(`${identity.runtime} first server stream result was invalid`)
    }
    const pendingWatchNext = watch.next()
    await within(watchPending.promise, `${identity.runtime} pending server stream read`)
    cancelWatch()
    const watchNextError = await rejectedWithin(
      pendingWatchNext,
      `${identity.runtime} canceled server stream next`
    )
    const watchHandlerError = await within(
      watchObserved.promise,
      `${identity.runtime} server stream handler cancellation`
    )
    await within(watchFinished.promise, `${identity.runtime} server stream handler finally`)
    if (
      !isCanonicalCanceled(watchNextError) ||
      !isCanonicalCanceled(watchHandlerError) ||
      !isCanonicalCanceled(completionErrors[0]) ||
      completions[0] !== 1
    ) {
      throw new Error(`${identity.runtime} server stream cancellation was not canonical`)
    }

    const bidiContext = withCancel(background())
    cancelBidi = bidiContext[1]
    const bidi = orders
      .syncOrders(bidiContext[0], heldCommand("cancel-bidi", bidiGate.promise))
      [Symbol.asyncIterator]()
    const firstBidi = await within(bidi.next(), `${identity.runtime} first bidi read`)
    if (firstBidi.done === true || firstBidi.value.orderId !== "cancel-bidi") {
      throw new Error(`${identity.runtime} first bidi result was invalid`)
    }
    const pendingBidiNext = bidi.next()
    await within(bidiPending.promise, `${identity.runtime} pending bidi read`)
    cancelBidi()
    const bidiNextError = await rejectedWithin(
      pendingBidiNext,
      `${identity.runtime} canceled bidi next`
    )
    const bidiHandlerError = await within(
      bidiObserved.promise,
      `${identity.runtime} bidi handler cancellation`
    )
    await within(bidiFinished.promise, `${identity.runtime} bidi handler finally`)
    bidiGate.resolve()
    if (
      !isCanonicalCanceled(bidiNextError) ||
      !isCanonicalCanceled(bidiHandlerError) ||
      !isCanonicalCanceled(completionErrors[1]) ||
      completions[1] !== 1
    ) {
      throw new Error(`${identity.runtime} bidi cancellation was not canonical`)
    }

    const forced = orders
      .syncOrders(background(), heldCommand("force-bidi", forcedGate.promise))
      [Symbol.asyncIterator]()
    const firstForced = await within(forced.next(), `${identity.runtime} first forced bidi read`)
    if (firstForced.done === true || firstForced.value.orderId !== "force-bidi") {
      throw new Error(`${identity.runtime} first forced bidi result was invalid`)
    }
    const pendingForcedNext = forced.next()
    const stopContext = withCancel(background())
    stopContext[1]()
    const stopWaiterError = await rejectedWithin(
      owner.stop(stopContext[0]),
      `${identity.runtime} canceled stop waiter`
    )
    const forcedNextError = await rejectedWithin(
      pendingForcedNext,
      `${identity.runtime} forced bidi next`
    )
    const forcedHandlerError = await within(
      forcedObserved.promise,
      `${identity.runtime} forced bidi handler cancellation`
    )
    await within(forcedFinished.promise, `${identity.runtime} forced bidi handler finally`)
    forcedGate.resolve()
    await within(owner.stop(), `${identity.runtime} background server stop`)
    await within(owner.running, `${identity.runtime} server running settlement`)
    await within(client.close(background()), `${identity.runtime} client close`)
    if (
      !isCanonicalCanceled(stopWaiterError) ||
      !(forcedNextError instanceof Error) ||
      !isCanonicalCanceled(forcedHandlerError) ||
      JSON.stringify(completions) !== JSON.stringify([1, 1, 1]) ||
      counters.serverStreaming !== 1 ||
      counters.bidi !== 2 ||
      Object.values(handlerFinally).some((count) => count !== 1)
    ) {
      throw new Error(`${identity.runtime} forced stop evidence was invalid`)
    }

    evidence = Object.freeze({
      servers: 1 as const,
      serverStreaming: Object.freeze({
        nextCanonical: true as const,
        handlerCanonical: true as const
      }),
      bidi: Object.freeze({ nextCanonical: true as const, handlerCanonical: true as const }),
      forcedStop: Object.freeze({
        waiterCanonical: true as const,
        activeNextRejected: true as const,
        handlerCanonical: true as const,
        backgroundStop: true as const,
        running: true as const
      }),
      selectionCompletions: Object.freeze([1, 1, 1] as const),
      handlerFinally: { ...handlerFinally },
      cleanup: Object.freeze({
        client: true as const,
        server: true as const,
        running: true as const
      })
    })
  } catch (error) {
    primary = error
  }

  cancelWatch?.()
  cancelBidi?.()
  bidiGate.resolve()
  forcedGate.resolve()
  const cleanupFailures: unknown[] = []
  try {
    await within(client.close(background()), `${identity.runtime} lifecycle client cleanup`)
  } catch (error) {
    cleanupFailures.push(error)
  }
  try {
    await within(owner.stop(), `${identity.runtime} lifecycle server cleanup`)
  } catch (error) {
    cleanupFailures.push(error)
  }
  try {
    await within(owner.running, `${identity.runtime} lifecycle running cleanup`)
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (primary !== null)
    combine(primary, cleanupFailures, "managed gRPC lifecycle and cleanup failed")
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, "managed gRPC lifecycle cleanup failed")
  }
  if (evidence === null) throw new Error("managed gRPC lifecycle produced no evidence")
  return evidence
}

export async function runManagedSelfTest(identity: NativeRuntimeIdentity) {
  const owner = await startManagedServer()
  let client: Client | null = null
  let result: NativeCardinalityResult | null = null
  let primary: unknown = null
  try {
    client = newClient(withEndpoint(owner.endpoint))
    result = await exercise(client)
    if (JSON.stringify(result) !== JSON.stringify(ExpectedResult)) {
      throw new Error(`${identity.runtime} managed gRPC result mismatch`)
    }
  } catch (error) {
    primary = error
  }

  const cleanupFailures: unknown[] = []
  if (client !== null) {
    try {
      await client.close(background())
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  try {
    await owner.stop()
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (primary !== null) combine(primary, cleanupFailures, "managed gRPC call and cleanup failed")
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, "managed gRPC cleanup failed")
  }
  if (result === null) throw new Error("managed gRPC self-test produced no result")

  return Object.freeze({
    kind: "managed-self-test" as const,
    ...identity,
    result,
    counters: { ...owner.counters },
    cleanup: { client: true, server: true, running: true },
    lifecycle: await runManagedLifecycleTest(identity),
    faults: await runManagedFaultTests()
  })
}
