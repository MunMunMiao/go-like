import assert from "node:assert/strict"
import {
  createServer,
  constants,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from "node:http2"
import { setTimeout as pause } from "node:timers/promises"

import { create, toBinary } from "@bufbuild/protobuf"
import { ConnectError } from "@connectrpc/connect"
import { background, canceled, withCancel, withTimeout, type Context } from "@go-like/context"
import { newRoundRobinSelector, type SelectionOutcome } from "@go-like/registry"
import {
  address,
  newClient,
  newServer,
  withAddress,
  withSelector,
  type Client,
  type Server
} from "@go-like/transport-grpc-buf/native"

import { OrderEventSchema } from "../../.artifacts/gen/order/v1/order_pb.js"
import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceHandler
} from "../../.artifacts/gen/order/v1/order_like.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function within<T>(operation: Promise<T>): Promise<T> {
  const timer = new AbortController()
  try {
    return await Promise.race([
      operation,
      pause(5_000, undefined, { signal: timer.signal }).then(() => {
        throw new Error("native fault regression exceeded 5 seconds")
      })
    ])
  } finally {
    timer.abort()
  }
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  return await within(
    operation.then(
      () => assert.fail("faulted RPC unexpectedly succeeded"),
      (error: unknown) => error
    )
  )
}

async function aborted(ctx: Context): Promise<void> {
  const signal = ctx.done()
  assert.ok(signal, "handler and producer must have cancellation")
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    )
  }
}

async function cleanup(
  primary: unknown | null,
  ...actions: readonly (() => unknown)[]
): Promise<void> {
  const failures: unknown[] = primary === null ? [] : [primary]
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, "native fault regression and cleanup failed")
}

async function stopServer(server: Server): Promise<void> {
  const [ctx, cancel] = withTimeout(background(), 5_000)
  try {
    await within(server.stop(ctx))
  } finally {
    cancel()
  }
}

async function managed(handler: Partial<OrderServiceHandler>) {
  const server = newServer(address("127.0.0.1:0"))
  registerOrderServiceHandler(server, {
    getOrder: (_ctx, request) => ({ id: request.id, state: "READY" }),
    delete$: (_ctx, request) => ({ id: request.id, state: "DELETED" }),
    async *watchOrders() {},
    async uploadEvents() {
      return { count: 0 }
    },
    async *syncOrders() {},
    ...handler
  })
  const running = server.start(background())
  void running.catch(() => {})
  let client: Client
  try {
    client = newClient(withAddress(await within(Promise.resolve(server.endpoint(background())))))
  } catch (error) {
    await cleanup(
      error,
      () => stopServer(server),
      () => within(running)
    )
    throw error
  }
  return {
    server,
    client,
    running,
    orders: newOrderServiceClient(client),
    async cleanup() {
      await cleanup(
        null,
        () => within(client.close(background())),
        () => stopServer(server),
        () => within(running)
      )
    }
  }
}

async function canceledRequestsAndClose() {
  const uploadEntered = deferred()
  const uploadFinished = deferred()
  const unaryEntered = deferred()
  const unaryFinished = deferred()
  const producerFinished = deferred()
  const canceledContext = withCancel(background())
  const uploadContext = withCancel(background())
  const counts = {
    unary: 0,
    upload: 0,
    producer: 0,
    uploadFinally: 0,
    producerFinally: 0,
    unaryFinally: 0,
    serverStreaming: 0,
    bidi: 0
  }
  const owner = await managed({
    async getOrder(ctx, request) {
      counts.unary += 1
      unaryEntered.resolve()
      try {
        await aborted(ctx)
        assert.equal(ctx.err(), canceled)
        return { id: request.id, state: "CANCELED" }
      } finally {
        counts.unaryFinally += 1
        unaryFinished.resolve()
      }
    },
    async uploadEvents(ctx, requests) {
      counts.upload += 1
      try {
        for await (const request of requests) {
          assert.equal(request.orderId, "first-upload")
          uploadEntered.resolve()
          await aborted(ctx)
          assert.equal(ctx.err(), canceled)
          break
        }
        return { count: 1 }
      } finally {
        counts.uploadFinally += 1
        uploadFinished.resolve()
      }
    },
    async *watchOrders() {
      counts.serverStreaming += 1
      yield* []
    },
    async *syncOrders() {
      counts.bidi += 1
      yield* []
    }
  })
  async function* upload(ctx: Context) {
    counts.producer += 1
    try {
      yield { orderId: "first-upload", type: "CREATED" }
      await aborted(ctx)
    } finally {
      counts.producerFinally += 1
      producerFinished.resolve()
    }
  }
  let primary: unknown = null
  try {
    canceledContext[1]()
    const ctx = canceledContext[0]
    const preCanceled = [
      owner.orders.getOrder(ctx, { id: "never" }),
      owner.orders.watchOrders(ctx, { customerId: "never" })[Symbol.asyncIterator]().next(),
      owner.orders.uploadEvents(ctx, upload(ctx)),
      owner.orders
        .syncOrders(
          ctx,
          (async function* () {
            counts.producer += 1
            yield { orderId: "never", action: "CREATE" }
          })()
        )
        [Symbol.asyncIterator]()
        .next()
    ]
    const errors = await Promise.all(preCanceled.map(failure))
    for (const error of errors) assert.equal(error, canceled)
    assert.equal(counts.unary + counts.upload + counts.producer, 0)

    const uploadResult = failure(
      owner.orders.uploadEvents(uploadContext[0], upload(uploadContext[0]))
    )
    await within(uploadEntered.promise)
    uploadContext[1]()
    assert.equal(await uploadResult, canceled)
    await within(Promise.all([uploadFinished.promise, producerFinished.promise]))
    assert.deepEqual(
      [counts.upload, counts.uploadFinally, counts.producer, counts.producerFinally],
      [1, 1, 1, 1]
    )

    const unaryResult = failure(owner.orders.getOrder(background(), { id: "close-active" }))
    await within(unaryEntered.promise)
    await within(Promise.all([owner.client.close(background()), owner.client.close(background())]))
    const closeError = await unaryResult
    assert.ok(closeError instanceof Error)
    assert.equal(closeError.message, "gRPC client is closed")
    await within(unaryFinished.promise)
    assert.equal(counts.unaryFinally, 1)
    assert.ok(
      (await failure(owner.orders.getOrder(background(), { id: "closed" }))) instanceof Error
    )
    assert.equal(counts.unary, 1)
  } catch (error) {
    primary = error
  }
  canceledContext[1]()
  uploadContext[1]()
  await cleanup(
    primary,
    () => owner.cleanup(),
    () => {
      assert.equal(counts.serverStreaming, 0, "pre-canceled server stream reached handler")
      assert.equal(counts.bidi, 0, "pre-canceled bidi reached handler")
    }
  )
  return { preCanceledCardinalities: 4, counts, repeatedClose: true }
}

async function gracefulDrain() {
  const entered = deferred()
  const release = deferred()
  const payload = "x".repeat(64 * 1024)
  const contexts: Context[] = []
  let finalized = 0
  const owner = await managed({
    async getOrder(ctx, request) {
      contexts.push(ctx)
      entered.resolve()
      await release.promise
      assert.equal(ctx.err(), null)
      return { id: request.id, state: payload }
    },
    async *watchOrders(ctx) {
      contexts.push(ctx)
      try {
        yield { orderId: payload, type: "READY", sequence: 1 }
        await release.promise
        for (let sequence = 2; sequence <= 16; sequence += 1) {
          assert.equal(ctx.err(), null)
          yield { orderId: payload, type: "READY", sequence }
        }
      } finally {
        finalized += 1
      }
    }
  })
  let primary: unknown = null
  let received = 1
  try {
    const unary = owner.orders.getOrder(background(), { id: "draining" })
    void unary.catch(() => {})
    const stream = owner.orders
      .watchOrders(background(), { customerId: "slow" })
      [Symbol.asyncIterator]()
    const first = await within(stream.next())
    assert.equal(first.done, false)
    assert.equal(first.value?.orderId, payload)
    assert.equal(first.value?.sequence, 1)
    await within(entered.promise)
    let stopped = false
    const stopping = owner.server.stop(background()).then(() => {
      stopped = true
    })
    void stopping.catch(() => {})
    await pause(10)
    assert.equal(stopped, false, "stop must wait for admitted RPCs")
    for (const ctx of contexts) assert.equal(ctx.err(), null)
    release.resolve()
    assert.equal((await within(unary)).state, payload)
    for (;;) {
      await pause(2)
      const next = await within(stream.next())
      if (next.done) break
      received += 1
      assert.equal(next.value.sequence, received)
      assert.equal(next.value.orderId, payload)
    }
    await within(stopping)
    assert.equal(received, 16)
    assert.equal(finalized, 1)
  } catch (error) {
    primary = error
  }
  release.resolve()
  await cleanup(primary, () => owner.cleanup())
  return {
    inflightUnaryCompleted: true,
    messages: received,
    payloadBytes: payload.length,
    delayedReadMs: 2,
    handlerFinally: finalized
  }
}

async function peerReset() {
  const server = createServer()
  const sessions = new Set<ServerHttp2Session>()
  const reset = deferred()
  let requests = 0
  let completions = 0
  const outcomes: SelectionOutcome[] = []
  server.on("session", (session) => {
    sessions.add(session)
    session.on("close", () => sessions.delete(session))
  })
  server.on("stream", (stream: ServerHttp2Stream) => {
    requests += 1
    const bytes = toBinary(
      OrderEventSchema,
      create(OrderEventSchema, { orderId: "prefix", sequence: 1 })
    )
    const frame = new Uint8Array(5 + bytes.length)
    new DataView(frame.buffer).setUint32(1, bytes.length)
    frame.set(bytes, 5)
    stream.respond({ ":status": 200, "content-type": "application/grpc" })
    stream.write(frame)
    void reset.promise.then(() => stream.close(constants.NGHTTP2_CANCEL))
  })
  let client: Client | null = null
  let primary: unknown = null
  let errorCode: number | null = null
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
    )
    const bound = server.address()
    assert.ok(bound && typeof bound !== "string")
    const roundRobin = newRoundRobinSelector()
    client = newClient(
      withAddress(`http://127.0.0.1:${bound.port}`),
      withSelector({
        select(ctx, instances, ...options) {
          const [selection, done] = roundRobin.select(ctx, instances, ...options)
          return [
            selection,
            (feedbackCtx, outcome) => {
              completions += 1
              outcomes.push(outcome)
              return done(feedbackCtx, outcome)
            }
          ]
        }
      })
    )
    const stream = newOrderServiceClient(client)
      .watchOrders(background(), { customerId: "reset" })
      [Symbol.asyncIterator]()
    const first = await within(stream.next())
    assert.equal(first.done, false)
    assert.equal(first.value?.orderId, "prefix")
    reset.resolve()
    const error = await failure(stream.next())
    assert.ok(error instanceof ConnectError)
    assert.notEqual(error.code, 0)
    assert.equal(requests, 1, "an established stream must not be replayed")
    assert.equal(completions, 1)
    assert.equal(outcomes[0]?.error, error)
    errorCode = error.code
  } catch (error) {
    primary = error
  }
  reset.resolve()
  await cleanup(
    primary,
    () => (client === null ? undefined : within(client.close(background()))),
    ...Array.from(sessions, (session) => () => session.destroy()),
    () =>
      within(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
      )
  )
  assert.notEqual(errorCode, null)
  return { receivedPrefix: 1, requests, completions, errorCode }
}

export async function runManagedFaultTests() {
  const primary = new Error("primary failure")
  const cleanupFailure = new Error("cleanup failure")
  const actions: number[] = []
  const failureEvidence = await cleanup(
    primary,
    () => {
      actions.push(1)
      throw cleanupFailure
    },
    () => {
      actions.push(2)
    }
  ).catch((error: unknown) => error)
  assert.ok(failureEvidence instanceof AggregateError)
  assert.deepEqual(failureEvidence.errors, [primary, cleanupFailure])
  assert.deepEqual(actions, [1, 2])
  const cancellation = await canceledRequestsAndClose().catch((cause: unknown) => {
    throw new Error("native cancellation/close regression failed", { cause })
  })
  const drain = await gracefulDrain().catch((cause: unknown) => {
    throw new Error("native graceful drain regression failed", { cause })
  })
  const reset = await peerReset().catch((cause: unknown) => {
    throw new Error("native peer reset regression failed", { cause })
  })
  return {
    canceledRequestsAndClose: cancellation,
    gracefulDrain: drain,
    peerReset: reset
  }
}
