import { expect, test } from "bun:test"
import { Code, ConnectError, type StreamResponse, type Transport } from "@connectrpc/connect"
import type { Context } from "@go-like/context"
import {
  background,
  canceled,
  deadlineExceeded,
  withCancelCause,
  withValue
} from "@go-like/context"
import type {
  Discovery,
  SelectionOutcome,
  Selector,
  ServiceInstance,
  Watcher
} from "@go-like/registry"
import { newRoundRobinSelector } from "@go-like/registry"
import type { TLSConfig } from "@go-like/transport"

import { OrderService } from "../.artifacts/gen/order/v1/order_pb.js"
import { callOptions } from "../src/index"
import { newClientForTest, type ClientFactories } from "../src/client"
import {
  newClient,
  withAddress,
  withDiscovery,
  withSelector,
  withService,
  withBlock,
  withTLSConfig
} from "../src/native"

const unaryMethod = OrderService.method.getOrder
const streamMethod = OrderService.method.watchOrders

function unaryReply(id: string) {
  return {
    stream: false as const,
    service: OrderService,
    method: unaryMethod,
    header: new Headers(),
    trailer: new Headers(),
    message: { $typeName: "order.v1.Order" as const, id, state: "READY" }
  }
}

function asTransport(
  unary: (...args: readonly unknown[]) => Promise<unknown>,
  stream: (...args: readonly unknown[]) => Promise<unknown> = async () => {
    throw new Error("unexpected stream")
  }
): Transport {
  return {
    unary: unary as Transport["unary"],
    stream: stream as Transport["stream"]
  }
}

function streamReply(message: AsyncIterable<unknown>): StreamResponse {
  return {
    stream: true,
    service: OrderService,
    method: streamMethod,
    header: new Headers({ "x-reply": "ready" }),
    trailer: new Headers(),
    message
  } as StreamResponse
}

async function* emptyInput() {}

function inertManager(authority: string) {
  return {
    authority,
    request: async () => {
      throw new Error("manager request is not used by this test")
    },
    notifyResponseByteRead: () => {},
    abort: () => {}
  }
}

function runtime(
  transport: Transport,
  created: string[] = [],
  managers: ReturnType<typeof inertManager>[] = []
) {
  return {
    createManager(address: string, _tls?: unknown) {
      created.push(address)
      const manager = inertManager(address)
      managers.push(manager)
      return manager
    },
    createTransport(_address: string) {
      return transport
    }
  }
}

test("direct unary delegates through one Selector snapshot containing every address", async () => {
  const selectedSnapshots: (readonly ServiceInstance[])[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      selectedSnapshots.push(instances)
      const instance = instances[0]
      if (instance === undefined) throw new Error("expected direct instance")
      const url = instance.endpoints[1]
      if (url === undefined) throw new Error("expected second address")
      return [{ instance, url }, () => {}]
    }
  }
  const upstreamCalls: (readonly unknown[])[] = []
  const transport = asTransport(async (...args) => {
    upstreamCalls.push(args)
    return unaryReply("selected")
  })
  const created: string[] = []
  const client = newClientForTest(
    runtime(transport, created),
    withAddress("https://one.example.test", "https://two.example.test/"),
    withSelector(selector)
  )

  const reply = await client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })

  expect(reply.message.id).toBe("selected")
  expect(selectedSnapshots).toHaveLength(1)
  expect(selectedSnapshots[0]?.[0]?.endpoints).toEqual([
    "https://one.example.test/",
    "https://two.example.test/"
  ])
  expect(created).toEqual(["https://two.example.test/"])
  expect(upstreamCalls).toHaveLength(1)
})

test("raw unary preserves zero and negative timeout values without a fallback deadline", async () => {
  const observedTimeouts: unknown[] = []
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async (_method, _signal, timeoutMs, _header, input) => {
        observedTimeouts.push(timeoutMs)
        return unaryReply((input as { readonly id: string }).id)
      }),
      created
    ),
    withAddress("https://rpc.example.test")
  )

  for (const timeoutMs of [0, -1]) {
    const response = await client.unary(unaryMethod, undefined, timeoutMs, undefined, {
      id: String(timeoutMs)
    })
    expect(response.message.id).toBe(String(timeoutMs))
  }

  expect(observedTimeouts).toEqual([0, -1])
  expect(created).toEqual(["https://rpc.example.test/"])
  await client.close(background())
})

test("Discovery refresh permits an explicit unary retry and never replays a partial stream", async () => {
  const dead = "https://a-dead.example.test/"
  const healthy = "https://b-healthy.example.test/"
  let snapshot = [serviceInstance("orders", dead, healthy)]
  const update = Promise.withResolvers<readonly ServiceInstance[]>()
  const refreshed = Promise.withResolvers<void>()
  let nextCalls = 0
  const discovery: Discovery = {
    async getService() {
      return snapshot
    },
    async watch() {
      return {
        async next(ctx) {
          nextCalls += 1
          if (nextCalls === 1) return snapshot
          if (nextCalls === 2) return await update.promise
          refreshed.resolve()
          return await new Promise<readonly ServiceInstance[]>((_resolve, reject) => {
            const signal = ctx.done()
            if (signal?.aborted) reject(ctx.err())
            else signal?.addEventListener("abort", () => reject(ctx.err()), { once: true })
          })
        },
        async stop() {}
      }
    }
  }
  const unavailable = new ConnectError("endpoint unavailable", Code.Unavailable)
  const interrupted = new ConnectError("stream interrupted after one reply", Code.Unavailable)
  const calls: string[] = []
  const outcomes: SelectionOutcome[] = []
  const roundRobin = newRoundRobinSelector()
  const client = newClientForTest(
    {
      createManager: inertManager,
      createTransport(endpoint) {
        return asTransport(
          async () => {
            calls.push(`unary:${endpoint}`)
            if (endpoint === dead) throw unavailable
            return unaryReply("retried")
          },
          async () => {
            calls.push(`stream:${endpoint}`)
            return streamReply(
              (async function* () {
                yield { orderId: "prefix", type: "READY", sequence: 1 }
                throw interrupted
              })()
            )
          }
        )
      }
    },
    withService("orders"),
    withDiscovery(discovery),
    withSelector({
      select(ctx, instances, ...options) {
        const [selection, done] = roundRobin.select(ctx, instances, ...options)
        return [
          selection,
          (feedbackCtx, outcome) => {
            outcomes.push(outcome)
            return done(feedbackCtx, outcome)
          }
        ]
      }
    })
  )
  try {
    await expect(
      client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
    ).rejects.toBe(unavailable)
    expect(calls).toEqual([`unary:${dead}`])
    snapshot = [serviceInstance("orders", healthy)]
    update.resolve(snapshot)
    await refreshed.promise
    expect(
      (await client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })).message.id
    ).toBe("retried")
    const response = await client.stream(
      streamMethod,
      undefined,
      undefined,
      undefined,
      emptyInput()
    )
    const reader = response.message[Symbol.asyncIterator]()
    expect((await reader.next()).value).toEqual({ orderId: "prefix", type: "READY", sequence: 1 })
    await expect(reader.next()).rejects.toBe(interrupted)
    expect(calls).toEqual([`unary:${dead}`, `unary:${healthy}`, `stream:${healthy}`])
    expect(outcomes.map(({ error }) => error)).toEqual([unavailable, null, interrupted])
  } finally {
    update.resolve(snapshot)
    await client.close(background())
  }
})

test("an already-aborted raw signal preserves its Error before selection", async () => {
  const reason = new Error("raw signal canceled")
  const controller = new AbortController()
  controller.abort(reason)
  let upstreamCalls = 0
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async () => {
        upstreamCalls += 1
        return unaryReply("never")
      }),
      created
    ),
    withAddress("https://rpc.example.test")
  )

  await expect(
    client.unary(unaryMethod, controller.signal, undefined, undefined, { id: "one" })
  ).rejects.toBe(reason)
  expect(created).toEqual([])
  expect(upstreamCalls).toBe(0)
  await client.close(background())
})

test("raw stream preserves zero and negative timeout values without a fallback deadline", async () => {
  const observedTimeouts: unknown[] = []
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(
        async () => unaryReply("unused"),
        async (_method, _signal, timeoutMs) => {
          observedTimeouts.push(timeoutMs)
          return streamReply(emptyInput())
        }
      ),
      created
    ),
    withAddress("https://rpc.example.test")
  )

  for (const timeoutMs of [0, -1]) {
    const response = await client.stream(
      streamMethod,
      undefined,
      timeoutMs,
      undefined,
      emptyInput()
    )
    expect(await Array.fromAsync(response.message)).toEqual([])
  }

  expect(observedTimeouts).toEqual([0, -1])
  expect(created).toEqual(["https://rpc.example.test/"])
  await client.close(background())
})

test("invalid construction states and URL forms fail before manager creation", () => {
  const transport = asTransport(async () => unaryReply("unused"))
  const created: string[] = []
  const factories = runtime(transport, created)
  const discovery = {
    getService: async () => Object.freeze([]),
    watch: async () => {
      throw new Error("unused")
    }
  }

  expect(() => newClientForTest(factories)).toThrow()
  expect(() => newClientForTest(factories, withService("order.v1.OrderService"))).toThrow()
  expect(() => newClientForTest(factories, withDiscovery(discovery))).toThrow()
  expect(() =>
    newClientForTest(
      factories,
      withAddress("https://one.example.test"),
      withDiscovery(discovery),
      withService("order.v1.OrderService")
    )
  ).toThrow()
  for (const address of [
    "ftp://one.example.test/",
    "https://user:secret@one.example.test/",
    "https://one.example.test/rpc",
    "https://one.example.test/?query=yes",
    "https://one.example.test/#fragment"
  ]) {
    expect(() => newClientForTest(factories, withAddress(address))).toThrow()
  }
  expect(() => withAddress("HTTPS://ONE.EXAMPLE.TEST:443", "https://one.example.test/")).toThrow()
  expect(created).toEqual([])
})

test("canonical equivalent Discovery roots share one address owner", async () => {
  let selection = 0
  const discovery = discoveryWithSnapshot(
    Object.freeze([
      serviceInstance(
        "order.v1.OrderService",
        "HTTPS://ONE.EXAMPLE.TEST:443",
        "https://one.example.test/"
      )
    ])
  )
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[selection++]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, () => {}]
    }
  }
  const created: string[] = []
  const transport = asTransport(async (_method, _signal, _timeout, _header, input) => {
    return unaryReply((input as { readonly id: string }).id)
  })
  const client = newClientForTest(
    runtime(transport, created),
    withDiscovery(discovery),
    withService("order.v1.OrderService"),
    withSelector(selector)
  )

  expect(
    (await client.unary(unaryMethod, undefined, undefined, undefined, { id: "first" })).message.id
  ).toBe("first")
  expect(
    (await client.unary(unaryMethod, undefined, undefined, undefined, { id: "second" })).message.id
  ).toBe("second")
  expect(created).toEqual(["https://one.example.test/"])
  await client.close(background())
})

test("uses orders-grpc construction service while preserving the protobuf wire service", async () => {
  const discoveredServices: string[] = []
  const watchedServices: string[] = []
  const discovery: Discovery = {
    async getService(_ctx, service) {
      discoveredServices.push(service)
      return Object.freeze([serviceInstance("orders-grpc", "https://orders-grpc.example.test")])
    },
    async watch(_ctx, service) {
      watchedServices.push(service)
      const waiting = Promise.withResolvers<readonly ServiceInstance[]>()
      return {
        next(ctx) {
          const signal = ctx.done()
          if (signal !== null) {
            signal.addEventListener("abort", () => waiting.reject(ctx.err() ?? canceled), {
              once: true
            })
          }
          return waiting.promise
        },
        async stop() {}
      }
    }
  }
  const selectedEndpoints: string[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected gRPC endpoint")
      selectedEndpoints.push(url)
      return [{ instance, url }, () => {}]
    }
  }
  const delegatedMethods: unknown[] = []
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async (method) => {
        delegatedMethods.push(method)
        return unaryReply("orders-grpc")
      }),
      created
    ),
    withDiscovery(discovery),
    withService("orders-grpc"),
    withSelector(selector)
  )

  const response = await client.unary(unaryMethod, undefined, undefined, undefined, {
    id: "wire-order"
  })

  expect(response.message.id).toBe("orders-grpc")
  expect(discoveredServices).toEqual(["orders-grpc"])
  expect(watchedServices).toEqual(["orders-grpc"])
  expect(selectedEndpoints).toEqual(["https://orders-grpc.example.test"])
  expect(created).toEqual(["https://orders-grpc.example.test/"])
  expect(delegatedMethods).toEqual([unaryMethod])
  await client.close(background())
})

test("concurrent unary calls to one canonical address share one owner", async () => {
  const bothDelegated = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let delegated = 0
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async (_method, _signal, _timeout, _header, input) => {
        delegated += 1
        if (delegated === 2) bothDelegated.resolve()
        await release.promise
        return unaryReply((input as { readonly id: string }).id)
      }),
      created
    ),
    withAddress("https://rpc.example.test")
  )

  const first = client.unary(unaryMethod, undefined, undefined, undefined, { id: "first" })
  const second = client.unary(unaryMethod, undefined, undefined, undefined, { id: "second" })
  await bothDelegated.promise

  expect(created).toEqual(["https://rpc.example.test/"])
  expect(delegated).toBe(2)
  release.resolve()
  expect((await first).message.id).toBe("first")
  expect((await second).message.id).toBe("second")
  await client.close(background())
})

test("the public constructor exists independently of the private test seam", () => {
  const client = newClient(withAddress("https://rpc.example.test"))
  expect(client).toHaveProperty("unary")
  expect(client).toHaveProperty("stream")
  expect(client).toHaveProperty("close")
})

test("distinct selections create distinct owners and unary feedback settles once", async () => {
  const outcomes: SelectionOutcome[] = []
  let selection = 0
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      if (instance === undefined) throw new Error("expected direct instance")
      const url = instance.endpoints[selection++ % instance.endpoints.length]
      if (url === undefined) throw new Error("expected address")
      return [{ instance, url }, (_feedbackCtx, outcome) => outcomes.push(outcome)]
    }
  }
  const transport = asTransport(async (_method, _signal, _timeout, _header, input) => {
    const id = (input as { readonly id: string }).id
    if (id === "reject") throw new Error("upstream rejected")
    return unaryReply(id)
  })
  const created: string[] = []
  const client = newClientForTest(
    runtime(transport, created),
    withAddress("https://one.example.test", "https://two.example.test"),
    withSelector(selector)
  )

  await client.unary(unaryMethod, undefined, undefined, undefined, { id: "resolve" })
  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "reject" })
  ).rejects.toThrow("upstream rejected")

  expect(created).toEqual(["https://one.example.test/", "https://two.example.test/"])
  expect(outcomes).toHaveLength(2)
  expect(outcomes[0]?.error).toBeNull()
  expect(outcomes[1]?.error?.message).toBe("upstream rejected")
})

test("malformed selected URLs complete unary and stream admission exactly once", async () => {
  const outcomes: SelectionOutcome[] = []
  const created: string[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      if (instance === undefined) throw new Error("expected direct instance")
      return [
        { instance, url: "not an absolute URL" },
        (_feedbackCtx, outcome) => outcomes.push(outcome)
      ]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(async () => {
        throw new Error("invalid selected URL must not reach upstream")
      }),
      created
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  ).rejects.toThrow("absolute URL")
  await expect(
    client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  ).rejects.toThrow("absolute URL")

  expect(outcomes).toHaveLength(2)
  expect(outcomes[0]?.error?.message).toContain("absolute URL")
  expect(outcomes[1]?.error?.message).toContain("absolute URL")
  expect(created).toEqual([])
  await client.close(background())
})

test("http selections with TLS complete unary and stream admission exactly once", async () => {
  const outcomes: SelectionOutcome[] = []
  const created: string[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      if (instance === undefined) throw new Error("expected direct instance")
      return [
        { instance, url: "http://rpc.example.test" },
        (_feedbackCtx, outcome) => outcomes.push(outcome)
      ]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(async () => {
        throw new Error("insecure TLS selection must not reach upstream")
      }),
      created
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector),
    withTLSConfig({
      serverName: null,
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    })
  )

  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  ).rejects.toThrow("cannot use TLS")
  await expect(
    client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  ).rejects.toThrow("cannot use TLS")

  expect(outcomes).toHaveLength(2)
  expect(outcomes[0]?.error?.message).toContain("cannot use TLS")
  expect(outcomes[1]?.error?.message).toContain("cannot use TLS")
  expect(created).toEqual([])
  await client.close(background())
})

test("unary preserves upstream and feedback failures in order", async () => {
  const upstreamFailure = new Error("upstream failed")
  const feedbackFailure = new Error("feedback failed")
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        () => {
          throw feedbackFailure
        }
      ]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(async () => {
        throw upstreamFailure
      })
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  let observed: unknown
  try {
    await client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  } catch (value) {
    observed = value
  }
  expect(observed).toBeInstanceOf(AggregateError)
  expect((observed as AggregateError).errors).toEqual([upstreamFailure, feedbackFailure])
  await client.close(background())
})

test("stream delegation preserves response fields and reports terminal done or rejection once", async () => {
  const outcomes: SelectionOutcome[] = []
  let mode: "done" | "reject" = "done"
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, (_feedbackCtx, outcome) => outcomes.push(outcome)]
    }
  }
  const transport = asTransport(
    async () => unaryReply("unused"),
    async () => {
      async function* messages() {
        yield { $typeName: "order.v1.OrderEvent", orderId: "one", type: "READY", sequence: 1 }
        if (mode === "reject") throw new Error("stream rejected")
      }
      return streamReply(messages())
    }
  )
  const client = newClientForTest(
    runtime(transport),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  const completed = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  expect(completed.header.get("x-reply")).toBe("ready")
  expect(outcomes).toHaveLength(0)
  const completedIterator = completed.message[Symbol.asyncIterator]()
  expect((await completedIterator.next()).done).toBe(false)
  expect(await completedIterator.next()).toEqual({ done: true, value: undefined })
  expect(await completedIterator.next()).toEqual({ done: true, value: undefined })
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]?.error).toBeNull()

  mode = "reject"
  const rejected = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  await expect(Array.fromAsync(rejected.message)).rejects.toThrow("stream rejected")
  expect(outcomes).toHaveLength(2)
  expect(outcomes[1]?.error?.message).toBe("stream rejected")
})

test("stream return and throw abort before delegating and complete before first next", async () => {
  const outcomes: SelectionOutcome[] = []
  const abortStates: boolean[] = []
  const delegated: string[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, (_feedbackCtx, outcome) => outcomes.push(outcome)]
    }
  }
  const transport = asTransport(
    async () => unaryReply("unused"),
    async (...args) => {
      const signal = args[1] as AbortSignal
      const iterator: AsyncIterableIterator<unknown> = {
        next: async () => ({ done: false, value: { orderId: "never" } }),
        async return() {
          abortStates.push(signal.aborted)
          delegated.push("return")
          return { done: true, value: undefined }
        },
        async throw(error?: unknown) {
          abortStates.push(signal.aborted)
          delegated.push("throw")
          throw error
        },
        [Symbol.asyncIterator]() {
          return this
        }
      }
      return streamReply(iterator)
    }
  )
  const client = newClientForTest(
    runtime(transport),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  const returned = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  const returnIterator = returned.message[Symbol.asyncIterator]()
  expect(await returnIterator.return?.()).toEqual({ done: true, value: undefined })
  expect(await returnIterator.return?.()).toEqual({ done: true, value: undefined })

  const thrown = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  const throwIterator = thrown.message[Symbol.asyncIterator]()
  const failure = new Error("caller stopped")
  await expect(throwIterator.throw?.(failure)).rejects.toBe(failure)

  expect(abortStates).toEqual([true, true])
  expect(delegated).toEqual(["return", "throw"])
  expect(outcomes).toHaveLength(2)
})

test("caller cancellation and owner close complete active streams exactly once", async () => {
  const outcomes: SelectionOutcome[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, (_feedbackCtx, outcome) => outcomes.push(outcome)]
    }
  }
  const transport = asTransport(
    async () => unaryReply("unused"),
    async () => {
      const pending: AsyncIterableIterator<unknown> = {
        next: () => new Promise(() => {}),
        [Symbol.asyncIterator]() {
          return this
        }
      }
      return streamReply(pending)
    }
  )
  const client = newClientForTest(
    runtime(transport),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )
  const [ctx, cancel] = withCancelCause(background())

  const canceledStream = await client.stream(
    streamMethod,
    undefined,
    undefined,
    undefined,
    emptyInput(),
    callOptions(ctx).contextValues
  )
  const pendingNext = canceledStream.message[Symbol.asyncIterator]().next()
  cancel(canceled)
  await expect(pendingNext).rejects.toBe(canceled)
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]?.error).toBe(canceled)

  const ownerStream = await client.stream(
    streamMethod,
    undefined,
    undefined,
    undefined,
    emptyInput()
  )
  const ownerNext = ownerStream.message[Symbol.asyncIterator]().next()
  const ownerClosing = client.close(background())
  await expect(ownerNext).rejects.toThrow("closed")
  await ownerClosing
  expect(outcomes).toHaveLength(2)
  expect(outcomes[1]?.error?.message).toContain("closed")
})

test("stream caller cancellation preserves feedback failure for pending next", async () => {
  const feedbackFailure = new Error("stream cancellation feedback failed")
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        () => {
          throw feedbackFailure
        }
      ]
    }
  }
  const transport = asTransport(
    async () => unaryReply("unused"),
    async () => {
      const iterator: AsyncIterableIterator<unknown> = {
        next: () => new Promise(() => {}),
        [Symbol.asyncIterator]() {
          return this
        }
      }
      return streamReply(iterator)
    }
  )
  const client = newClientForTest(
    runtime(transport),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )
  const [ctx, cancel] = withCancelCause(background())
  const response = await client.stream(
    streamMethod,
    undefined,
    undefined,
    undefined,
    emptyInput(),
    callOptions(ctx).contextValues
  )
  const pending = response.message[Symbol.asyncIterator]().next()

  cancel(canceled)

  let observed: unknown
  try {
    await pending
  } catch (value) {
    observed = value
  }
  expect(observed).toBeInstanceOf(AggregateError)
  expect((observed as AggregateError).errors).toEqual([canceled, feedbackFailure])
  await client.close(background())
})

test("caller cancellation during pending stream setup settles one ordered feedback failure", async () => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<StreamResponse>()
  const feedbackFailure = new Error("pending setup cancellation feedback failed")
  const outcomes: SelectionOutcome[] = []
  let feedbackCalls = 0
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        (_feedbackCtx, outcome) => {
          feedbackCalls += 1
          outcomes.push(outcome)
          throw feedbackFailure
        }
      ]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(
        async () => unaryReply("unused"),
        async () => {
          entered.resolve()
          return pending.promise
        }
      )
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )
  const [ctx, cancel] = withCancelCause(background())
  const call = client.stream(
    streamMethod,
    undefined,
    undefined,
    undefined,
    emptyInput(),
    callOptions(ctx).contextValues
  )
  await entered.promise

  cancel(canceled)

  const result = await Promise.race([
    call.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    ),
    new Promise<{ readonly status: "pending" }>((resolve) => {
      setTimeout(() => resolve({ status: "pending" }), 100)
    })
  ])
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected") throw new Error("pending stream setup did not reject promptly")
  expect(feedbackCalls).toBe(1)
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]?.error).toBe(canceled)
  expect(result.error).toBeInstanceOf(AggregateError)
  expect((result.error as AggregateError).errors).toEqual([canceled, feedbackFailure])
  await client.close(background())
})

test("close during pending stream setup owns one ordered feedback failure", async () => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<StreamResponse>()
  const feedbackFailure = new Error("pending setup close feedback failed")
  const outcomes: SelectionOutcome[] = []
  let feedbackCalls = 0
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        (_feedbackCtx, outcome) => {
          feedbackCalls += 1
          outcomes.push(outcome)
          throw feedbackFailure
        }
      ]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(
        async () => unaryReply("unused"),
        async () => {
          entered.resolve()
          return pending.promise
        }
      )
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )
  const call = client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  await entered.promise

  const closing = client.close(background())
  const [callResult, closeResult] = await Promise.all([
    Promise.race([
      call.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ),
      new Promise<{ readonly status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 100)
      })
    ]),
    Promise.race([
      closing.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ),
      new Promise<{ readonly status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 100)
      })
    ])
  ])
  expect(callResult.status).toBe("rejected")
  expect(closeResult.status).toBe("rejected")
  if (callResult.status !== "rejected" || closeResult.status !== "rejected") {
    throw new Error("pending stream setup and close did not reject promptly")
  }
  expect(feedbackCalls).toBe(1)
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]?.error?.message).toBe("gRPC client is closed")
  expect(callResult.error).toBeInstanceOf(AggregateError)
  const failures = (callResult.error as AggregateError).errors
  expect((failures[0] as Error).message).toBe("gRPC client is closed")
  expect(failures[1]).toBe(feedbackFailure)
  expect(closeResult.error).toBe(callResult.error)
})

test("owner close reports an unconsumed stream feedback failure", async () => {
  const feedbackFailure = new Error("stream close feedback failed")
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        () => {
          throw feedbackFailure
        }
      ]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(
        async () => unaryReply("unused"),
        async () => streamReply(emptyInput())
      )
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  await expect(client.close(background())).rejects.toBe(feedbackFailure)
})

test("an already canceled stream call cannot create an owner or reach upstream", async () => {
  const [ctx, cancel] = withCancelCause(background())
  cancel(canceled)
  let upstreamCalls = 0
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(
        async () => unaryReply("unused"),
        async () => {
          upstreamCalls += 1
          return streamReply(emptyInput())
        }
      ),
      created
    ),
    withAddress("https://rpc.example.test")
  )

  await expect(
    client.stream(
      streamMethod,
      undefined,
      undefined,
      undefined,
      emptyInput(),
      callOptions(ctx).contextValues
    )
  ).rejects.toBe(canceled)
  expect(created).toEqual([])
  expect(upstreamCalls).toBe(0)
  await client.close(background())
})

test("an already canceled unary call cannot select or create an owner", async () => {
  const [ctx, cancel] = withCancelCause(background())
  cancel(canceled)
  let selections = 0
  let upstreamCalls = 0
  const created: string[] = []
  const selector: Selector = {
    select(_ctx, instances) {
      selections += 1
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, () => {}]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(async () => {
        upstreamCalls += 1
        return unaryReply("unused")
      }),
      created
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  await expect(
    client.unary(
      unaryMethod,
      undefined,
      undefined,
      undefined,
      { id: "one" },
      callOptions(ctx).contextValues
    )
  ).rejects.toBe(canceled)
  expect(selections).toBe(0)
  expect(created).toEqual([])
  expect(upstreamCalls).toBe(0)
  await client.close(background())
})

test("idempotent close aborts every owner, rejects future calls, and closes Discovery once", async () => {
  let watcherStops = 0
  const discovery = discoveryWithSnapshot(
    Object.freeze([serviceInstance("order.v1.OrderService", "https://rpc.example.test")]),
    () => {
      watcherStops += 1
    }
  )
  let aborts = 0
  const rawManager = {
    ...inertManager("https://rpc.example.test/"),
    abort: () => {
      aborts += 1
    }
  }
  const transport = asTransport(async () => unaryReply("resolved"))
  const client = newClientForTest(
    {
      createManager: () => rawManager,
      createTransport: () => transport
    },
    withDiscovery(discovery),
    withService("order.v1.OrderService")
  )

  await client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  const first = client.close(background())
  const second = client.close(background())
  await Promise.all([first, second])

  expect(aborts).toBe(1)
  expect(watcherStops).toBe(1)
  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "late" })
  ).rejects.toThrow("closed")
})

test("TLS is validated, copied, and mapped only into manager construction", async () => {
  const ca = new TextEncoder().encode(
    "-----BEGIN CERTIFICATE-----\nY2E=\n-----END CERTIFICATE-----\n"
  )
  const cert = new TextEncoder().encode(
    "-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----\n"
  )
  const key = new TextEncoder().encode(
    "-----BEGIN PRIVATE KEY-----\na2V5\n-----END PRIVATE KEY-----\n"
  )
  const tls: TLSConfig = {
    serverName: "rpc.internal.test",
    caCertificate: { encoding: "pem", bytes: ca },
    certificateChain: { encoding: "pem", bytes: cert },
    privateKey: { encoding: "pem", bytes: key }
  }
  const seen: unknown[] = []
  const client = newClientForTest(
    {
      createManager(address: string, options?: unknown) {
        seen.push(options)
        return inertManager(address)
      },
      createTransport: () => asTransport(async () => unaryReply("secure"))
    },
    withAddress("https://rpc.example.test"),
    withTLSConfig(tls)
  )
  ca.fill(0)
  cert.fill(0)
  key.fill(0)
  await client.unary(unaryMethod, undefined, undefined, undefined, { id: "secure" })
  const options = seen[0] as {
    readonly servername: string
    readonly ca: Uint8Array
    readonly cert: Uint8Array
    readonly key: Uint8Array
  }
  expect(options.servername).toBe("rpc.internal.test")
  expect(new TextDecoder().decode(options.ca)).toContain("BEGIN CERTIFICATE")
  expect(new TextDecoder().decode(options.cert)).toContain("BEGIN CERTIFICATE")
  expect(new TextDecoder().decode(options.key)).toContain("BEGIN PRIVATE KEY")

  expect(() =>
    newClientForTest(
      runtime(asTransport(async () => unaryReply("unused"))),
      withAddress("http://rpc.example.test"),
      withTLSConfig(tls)
    )
  ).toThrow()

  const discoveryCreated: string[] = []
  const insecureDiscoveryClient = newClientForTest(
    runtime(
      asTransport(async () => unaryReply("unused")),
      discoveryCreated
    ),
    withDiscovery(
      discoveryWithSnapshot(
        Object.freeze([serviceInstance("order.v1.OrderService", "http://rpc.example.test")])
      )
    ),
    withService("order.v1.OrderService"),
    withTLSConfig({
      serverName: null,
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    })
  )
  await expect(
    insecureDiscoveryClient.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  ).rejects.toThrow("cannot use TLS")
  expect(discoveryCreated).toEqual([])
  await insecureDiscoveryClient.close(background())
  expect(() =>
    newClientForTest(
      runtime(asTransport(async () => unaryReply("unused"))),
      withAddress("https://rpc.example.test"),
      withTLSConfig({ ...tls, privateKey: null })
    )
  ).toThrow()
  expect(() =>
    newClientForTest(
      runtime(asTransport(async () => unaryReply("unused"))),
      withAddress("https://rpc.example.test"),
      withTLSConfig({ ...tls, caCertificate: { encoding: "der", bytes: new Uint8Array([1]) } })
    )
  ).toThrow()
})

test("blocking Discovery and Selector observe the carried Like Context", async () => {
  const observed: Context[] = []
  const key = Object.freeze({})
  const ready = Promise.withResolvers<readonly ServiceInstance[]>()
  const watcher: Watcher = {
    next(ctx) {
      observed.push(ctx)
      const signal = ctx.done()
      if (signal === null) return ready.promise
      return Promise.race([
        ready.promise,
        new Promise<readonly ServiceInstance[]>((_, reject) => {
          const abort = () => reject(ctx.err() ?? canceled)
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        })
      ])
    },
    stop: async () => {}
  }
  const discovery: Discovery = {
    async getService(ctx) {
      observed.push(ctx)
      return Object.freeze([])
    },
    async watch(ctx) {
      observed.push(ctx)
      return watcher
    }
  }
  const selectedValues: unknown[] = []
  const selector: Selector = {
    select(ctx, instances) {
      selectedValues.push(ctx.value(key))
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, () => {}]
    }
  }
  const blockedCreated: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async () => unaryReply("resolved")),
      blockedCreated
    ),
    withDiscovery(discovery),
    withService("order.v1.OrderService"),
    withBlock(),
    withSelector(selector)
  )
  const [carried, cancel] = withCancelCause(withValue(background(), key, "carried"))
  const pending = client.unary(
    unaryMethod,
    undefined,
    undefined,
    undefined,
    { id: "one" },
    callOptions(carried).contextValues
  )
  cancel(canceled)
  await expect(pending).rejects.toBe(canceled)
  expect(selectedValues).toEqual([])
  expect(blockedCreated).toEqual([])

  const readyDiscovery = discoveryWithSnapshot(
    Object.freeze([serviceInstance("order.v1.OrderService", "https://rpc.example.test")])
  )
  const readyClient = newClientForTest(
    runtime(asTransport(async () => unaryReply("raw"))),
    withDiscovery(readyDiscovery),
    withService("order.v1.OrderService"),
    withSelector(selector)
  )
  const valued = withValue(background(), key, "carried")
  await readyClient.unary(
    unaryMethod,
    undefined,
    undefined,
    undefined,
    { id: "carried" },
    callOptions(valued).contextValues
  )
  expect(selectedValues.at(-1)).toBe("carried")
  await readyClient.unary(unaryMethod, new AbortController().signal, 50, undefined, { id: "raw" })
  expect(selectedValues.at(-1)).toBeNull()
  await readyClient.close(background())
  await client.close(background())
})

test.each([
  ["unary", "signal"],
  ["unary", "timeout"],
  ["stream", "signal"],
  ["stream", "timeout"]
] as const)(
  "carried Context honors %s %s overrides while Discovery blocks",
  async (kind, bound) => {
    const created: string[] = []
    const discoveryEntered = Promise.withResolvers<void>()
    const discovery = discoveryWithSnapshot([])
    const client = newClientForTest(
      runtime(
        asTransport(async () => unaryReply("never")),
        created
      ),
      withDiscovery({
        ...discovery,
        async getService() {
          discoveryEntered.resolve()
          return []
        }
      }),
      withService("orders"),
      withBlock()
    )
    const parent = withValue(background(), "request", "carried")
    const controller = new AbortController()
    const reason = new Error("call signal canceled")
    const options = callOptions(
      parent,
      bound === "signal" ? { signal: controller.signal } : { timeoutMs: 20 }
    )
    const call =
      kind === "unary"
        ? client.unary(
            unaryMethod,
            options.signal,
            options.timeoutMs,
            undefined,
            { id: "one" },
            options.contextValues
          )
        : client.stream(
            streamMethod,
            options.signal,
            options.timeoutMs,
            undefined,
            emptyInput(),
            options.contextValues
          )
    const settled = call.then(
      () => ({ error: null }),
      (error: unknown) => ({ error })
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await discoveryEntered.promise
      if (bound === "signal") controller.abort(reason)
      const result = await Promise.race([
        settled,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 100)
        })
      ])
      expect(result).toEqual({ error: bound === "signal" ? reason : deadlineExceeded })
      expect(created).toEqual([])
      expect(parent.err()).toBeNull()
    } finally {
      clearTimeout(timer)
      await client.close(background())
    }
  }
)

test("call bounds preserve carried values and the parent's cancellation cause", async () => {
  const entered = Promise.withResolvers<void>()
  const [parent, cancelParent] = withCancelCause(withValue(background(), "request", "carried"))
  const reason = new Error("parent canceled with a cause")
  const observed: unknown[] = []
  const selector = newRoundRobinSelector()
  const client = newClientForTest(
    runtime(
      asTransport(async (_method, signal) => {
        entered.resolve()
        return await new Promise((_resolve, reject) => {
          const bound = signal as AbortSignal
          bound.addEventListener("abort", () => reject(bound.reason), { once: true })
        })
      })
    ),
    withAddress("https://rpc.example.test"),
    withSelector({
      select(ctx, instances) {
        observed.push(ctx.value("request"))
        const [selected, done] = selector.select(ctx, instances)
        return [
          selected,
          (feedbackCtx, outcome) => {
            observed.push(feedbackCtx.value("request"), outcome.error)
            done(feedbackCtx, outcome)
          }
        ]
      }
    })
  )
  const options = callOptions(parent, {
    signal: new AbortController().signal,
    timeoutMs: 1_000
  })
  try {
    const pending = client.unary(
      unaryMethod,
      options.signal,
      options.timeoutMs,
      undefined,
      { id: "one" },
      options.contextValues
    )
    await entered.promise
    cancelParent(reason)
    await expect(pending).rejects.toBe(reason)
    expect(observed).toEqual(["carried", "carried", reason])
  } finally {
    cancelParent(null)
    await client.close(background())
  }
})

test("a canceled close waiter cannot abandon background cleanup or resurrect an owner", async () => {
  const stopped = Promise.withResolvers<void>()
  const discovery = discoveryWithSnapshot(
    Object.freeze([serviceInstance("order.v1.OrderService", "https://rpc.example.test")]),
    () => stopped.promise
  )
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async () => unaryReply("resolved")),
      created
    ),
    withDiscovery(discovery),
    withService("order.v1.OrderService")
  )
  await client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  const [waiter, cancelWaiter] = withCancelCause(background())
  cancelWaiter(canceled)
  await expect(client.close(waiter)).rejects.toBe(canceled)
  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "late" })
  ).rejects.toThrow("closed")
  stopped.resolve()
  await client.close(background())
  expect(created).toHaveLength(1)
})

test("late manager request settlement closes its stream and re-aborts the raw manager", async () => {
  const admitted = Promise.withResolvers<{ close: () => void; destroy: () => void }>()
  const requested = Promise.withResolvers<void>()
  let aborts = 0
  let closes = 0
  let resets = 0
  const raw = {
    authority: "https://rpc.example.test/",
    request: () => {
      requested.resolve()
      return admitted.promise
    },
    notifyResponseByteRead: () => {},
    abort: () => {
      aborts += 1
    }
  }
  const transportFactory = (
    _address: string,
    manager: Parameters<ClientFactories["createTransport"]>[1]
  ) =>
    asTransport(async () => {
      await manager.request("POST", "/service/method", {}, {})
      return unaryReply("late")
    })
  const client = newClientForTest(
    { createManager: () => raw, createTransport: transportFactory },
    withAddress("https://rpc.example.test")
  )
  const pending = client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  await requested.promise
  const closing = client.close(background())
  admitted.resolve({
    get close(): () => void {
      closes += 1
      throw new Error("hostile late close getter")
    },
    destroy: () => {
      resets += 1
    }
  })
  await expect(pending).rejects.toThrow("closed")
  await closing
  expect(closes).toBe(1)
  expect(resets).toBe(1)
  expect(aborts).toBeGreaterThanOrEqual(2)
})

test("late manager request rejection re-aborts before cleanup settles", async () => {
  const admitted = Promise.withResolvers<unknown>()
  const requested = Promise.withResolvers<void>()
  let aborts = 0
  const raw = {
    authority: "https://rpc.example.test/",
    request: () => {
      requested.resolve()
      return admitted.promise
    },
    notifyResponseByteRead: () => {},
    abort: () => {
      aborts += 1
    }
  }
  const client = newClientForTest(
    {
      createManager: () => raw,
      createTransport: (_address, manager) =>
        asTransport(async () => {
          await manager.request("POST", "/service/method", {}, {})
          return unaryReply("late")
        })
    },
    withAddress("https://rpc.example.test")
  )
  const pending = client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  await requested.promise
  const closing = client.close(background())
  admitted.reject(new Error("raw manager retry rejected"))
  await expect(pending).rejects.toThrow("closed")
  await closing
  expect(aborts).toBeGreaterThanOrEqual(2)
})

test("a transport factory failure owns rollback without replacing the primary failure", async () => {
  let aborts = 0
  const factoryFailure = new Error("transport factory rejected")
  const client = newClientForTest(
    {
      createManager(address) {
        return {
          ...inertManager(address),
          abort: () => {
            aborts += 1
          }
        }
      },
      createTransport() {
        throw factoryFailure
      }
    },
    withAddress("https://rpc.example.test")
  )

  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  ).rejects.toBe(factoryFailure)
  expect(aborts).toBe(1)
  await client.close(background())
  expect(aborts).toBe(1)

  const rollbackFailure = new Error("manager rollback failed")
  let rollbackAborts = 0
  const hostileClient = newClientForTest(
    {
      createManager(address) {
        return {
          ...inertManager(address),
          abort: () => {
            rollbackAborts += 1
            throw rollbackFailure
          }
        }
      },
      createTransport() {
        throw factoryFailure
      }
    },
    withAddress("https://rpc.example.test")
  )

  await expect(
    hostileClient.unary(unaryMethod, undefined, undefined, undefined, { id: "hostile" })
  ).rejects.toBe(factoryFailure)
  expect(rollbackAborts).toBe(1)
  await hostileClient.close(background())
})

test("hostile Context and non-Error failures are normalized at the client boundary", async () => {
  const rejected = Object.freeze({ source: "upstream" })
  const rejectedClient = newClientForTest(
    runtime(
      asTransport(async () => {
        throw rejected
      })
    ),
    withAddress("https://rpc.example.test")
  )

  let observed: unknown
  try {
    await rejectedClient.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  } catch (value) {
    observed = value
  }
  expect(observed).toBeInstanceOf(Error)
  expect((observed as Error).message).toBe("gRPC client boundary rejected")
  expect((observed as Error).cause).toBe(rejected)
  await rejectedClient.close(background())

  const contextFailure = new Error("hostile Context.err failed")
  const hostile: Context = {
    deadline: () => [new Date(-62_135_596_800_000), false],
    done: () => null,
    err: () => {
      throw contextFailure
    },
    value: () => null
  }
  let upstreamCalls = 0
  const contextClient = newClientForTest(
    runtime(
      asTransport(async () => {
        upstreamCalls += 1
        return unaryReply("never")
      })
    ),
    withAddress("https://rpc.example.test")
  )

  await expect(
    contextClient.unary(
      unaryMethod,
      undefined,
      undefined,
      undefined,
      { id: "one" },
      callOptions(hostile).contextValues
    )
  ).rejects.toBe(contextFailure)
  expect(upstreamCalls).toBe(0)
  await contextClient.close(background())
})

test("manager request boundaries preserve failures and close reports an abort failure", async () => {
  const syncFailure = new Error("raw request threw synchronously")
  const syncClient = clientUsingManager({
    ...inertManager("https://rpc.example.test/"),
    request: () => {
      throw syncFailure
    }
  })
  await expect(
    syncClient.unary(unaryMethod, undefined, undefined, undefined, { id: "sync" })
  ).rejects.toBe(syncFailure)
  await syncClient.close(background())

  const rejection = new Error("raw request rejected")
  const rejectedClient = clientUsingManager({
    ...inertManager("https://rpc.example.test/"),
    request: () => Promise.reject(rejection)
  })
  await expect(
    rejectedClient.unary(unaryMethod, undefined, undefined, undefined, { id: "reject" })
  ).rejects.toBe(rejection)
  await rejectedClient.close(background())

  const abortFailure = new Error("raw manager abort failed")
  const abortingClient = clientUsingManager({
    ...inertManager("https://rpc.example.test/"),
    request: () => Promise.resolve(Object.freeze({})),
    abort: () => {
      throw abortFailure
    }
  })
  expect(
    (await abortingClient.unary(unaryMethod, undefined, undefined, undefined, { id: "ok" })).message
      .id
  ).toBe("manager")
  await expect(abortingClient.close(background())).rejects.toBe(abortFailure)
})

test("late manager streams prefer close and tolerate a failing destroy getter", async () => {
  for (const mode of ["close", "destroy-getter"] as const) {
    const admitted = Promise.withResolvers<unknown>()
    const requested = Promise.withResolvers<void>()
    let closes = 0
    let destroyReads = 0
    let aborts = 0
    const client = clientUsingManager({
      authority: "https://rpc.example.test/",
      request: () => {
        requested.resolve()
        return admitted.promise
      },
      notifyResponseByteRead: () => {},
      abort: () => {
        aborts += 1
      }
    })
    const pending = client.unary(unaryMethod, undefined, undefined, undefined, { id: mode })
    await requested.promise
    const closing = client.close(background())

    admitted.resolve(
      mode === "close"
        ? {
            close: () => {
              closes += 1
            }
          }
        : {
            close: () => {
              closes += 1
              throw new Error("late close failed")
            },
            get destroy(): never {
              destroyReads += 1
              throw new Error("hostile destroy getter")
            }
          }
    )

    await expect(pending).rejects.toThrow("closed")
    await closing
    expect(closes).toBe(1)
    expect(destroyReads).toBe(mode === "close" ? 0 : 1)
    expect(aborts).toBeGreaterThanOrEqual(2)
  }
})

test("plain JavaScript Selector results are validated before manager creation", async () => {
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, () => {}]
    }
  }
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async () => unaryReply("never")),
      created
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )
  const cases: readonly { readonly selected: unknown; readonly message: string }[] = [
    { selected: undefined, message: "endpoint and completion tuple" },
    { selected: [null, () => {}], message: "endpoint must be an object" },
    {
      selected: [Object.freeze({ url: "https://rpc.example.test" }), null],
      message: "completion must be a function"
    }
  ]

  for (const entry of cases) {
    expect(Reflect.set(selector, "select", () => entry.selected)).toBeTrue()
    await expect(
      client.unary(unaryMethod, undefined, undefined, undefined, { id: entry.message })
    ).rejects.toThrow(entry.message)
  }

  expect(created).toEqual([])
  await client.close(background())
})

test("an asynchronous Selector completion is rejected and its rejection is consumed", async () => {
  const asyncFailure = new Error("asynchronous feedback rejected")
  let completions = 0
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        () => {
          completions += 1
          return Promise.reject(asyncFailure)
        }
      ]
    }
  }
  const client = newClientForTest(
    runtime(asTransport(async () => unaryReply("resolved"))),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  await expect(
    client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  ).rejects.toThrow("Selector completion must be synchronous")
  expect(completions).toBe(1)
  await client.close(background())
})

test("stream iterator terminal methods preserve abort-first settlement", async () => {
  const returnFailure = new Error("iterator return rejected")
  const requested = new Error("caller throw requested")
  const outcomes: SelectionOutcome[] = []
  const signals: AbortSignal[] = []
  let mode: "return" | "throw" | "missing-throw" = "return"
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [{ instance, url }, (_feedbackCtx, outcome) => outcomes.push(outcome)]
    }
  }
  const client = newClientForTest(
    runtime(
      asTransport(
        async () => unaryReply("unused"),
        async (_method, signal) => {
          signals.push(signal as AbortSignal)
          const iterator: AsyncIterableIterator<unknown> = {
            next: async () => ({ done: false, value: Object.freeze({}) }),
            ...(mode === "return"
              ? {
                  return: async () => {
                    throw returnFailure
                  }
                }
              : mode === "throw"
                ? {
                    throw: async (value?: unknown) => ({ done: true as const, value })
                  }
                : {}),
            [Symbol.asyncIterator]() {
              return this
            }
          }
          return streamReply(iterator)
        }
      )
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  const returned = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  await expect(returned.message[Symbol.asyncIterator]().return?.()).rejects.toBe(returnFailure)
  expect(signals[0]?.aborted).toBeTrue()
  expect(outcomes[0]?.error).toBe(returnFailure)

  mode = "throw"
  const handled = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  expect(await handled.message[Symbol.asyncIterator]().throw?.(requested)).toEqual({
    done: true,
    value: requested
  })
  expect(signals[1]?.aborted).toBeTrue()
  expect(outcomes[1]?.error).toBe(requested)

  mode = "missing-throw"
  const thrown = await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  await expect(thrown.message[Symbol.asyncIterator]().throw?.(requested)).rejects.toBe(requested)
  expect(signals[2]?.aborted).toBeTrue()
  expect(outcomes[2]?.error).toBe(requested)
  await client.close(background())
})

test("stream selection preserves selected-address and feedback failures in order", async () => {
  const feedbackFailure = new Error("stream selection feedback failed")
  const selector: Selector = {
    select(_ctx, instances) {
      const instance = instances[0]
      if (instance === undefined) throw new Error("expected address")
      return [
        { instance, url: "not an absolute URL" },
        () => {
          throw feedbackFailure
        }
      ]
    }
  }
  const client = newClientForTest(
    runtime(asTransport(async () => unaryReply("never"))),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )

  let observed: unknown
  try {
    await client.stream(streamMethod, undefined, undefined, undefined, emptyInput())
  } catch (value) {
    observed = value
  }
  expect(observed).toBeInstanceOf(AggregateError)
  const failures = (observed as AggregateError).errors
  expect((failures[0] as Error).message).toContain("absolute URL")
  expect(failures[1]).toBe(feedbackFailure)
  await client.close(background())
})

test("close racing asynchronous Discovery or synchronous selection creates no owner", async () => {
  const getService = Promise.withResolvers<readonly ServiceInstance[]>()
  const discoveryStarted = Promise.withResolvers<void>()
  const discovery: Discovery = {
    getService: () => {
      discoveryStarted.resolve()
      return getService.promise
    },
    watch: async () => ({
      next: () => new Promise(() => {}),
      stop: async () => {}
    })
  }
  const created: string[] = []
  const client = newClientForTest(
    runtime(
      asTransport(async () => unaryReply("never")),
      created
    ),
    withDiscovery(discovery),
    withService("order.v1.OrderService")
  )
  const pending = client.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  await discoveryStarted.promise
  const closing = client.close(background())
  getService.resolve(
    Object.freeze([serviceInstance("order.v1.OrderService", "https://rpc.example.test")])
  )
  await expect(pending).rejects.toThrow("closed")
  await closing
  expect(created).toEqual([])

  let selectingClient: ReturnType<typeof newClientForTest>
  const selectingCreated: string[] = []
  let selectionFeedback = 0
  const selector: Selector = {
    select(_ctx, instances) {
      void selectingClient.close(background())
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("expected address")
      return [
        { instance, url },
        () => {
          selectionFeedback += 1
        }
      ]
    }
  }
  selectingClient = newClientForTest(
    runtime(
      asTransport(async () => unaryReply("never")),
      selectingCreated
    ),
    withAddress("https://rpc.example.test"),
    withSelector(selector)
  )
  await expect(
    selectingClient.unary(unaryMethod, undefined, undefined, undefined, { id: "one" })
  ).rejects.toThrow("closed")
  await selectingClient.close(background())
  expect(selectingCreated).toEqual([])
  expect(selectionFeedback).toBe(1)
})

function serviceInstance(name: string, ...endpoints: readonly string[]): ServiceInstance {
  return Object.freeze({
    id: `${name}-1`,
    name,
    version: "v1",
    metadata: Object.freeze({}),
    endpoints: Object.freeze([...endpoints])
  })
}

function discoveryWithSnapshot(
  snapshot: readonly ServiceInstance[],
  onStop: () => void | Promise<void> = () => {}
): Discovery {
  return {
    async getService() {
      return snapshot
    },
    async watch() {
      const waiting = Promise.withResolvers<readonly ServiceInstance[]>()
      return {
        next(ctx) {
          const signal = ctx.done()
          if (signal !== null) {
            signal.addEventListener("abort", () => waiting.reject(ctx.err() ?? canceled), {
              once: true
            })
          }
          return waiting.promise
        },
        async stop() {
          await onStop()
        }
      }
    }
  }
}

function clientUsingManager(manager: ReturnType<ClientFactories["createManager"]>) {
  return newClientForTest(
    {
      createManager: () => manager,
      createTransport: (_address, owner) =>
        asTransport(async () => {
          await owner.request("POST", "/service/method", {}, {})
          return unaryReply("manager")
        })
    },
    withAddress("https://rpc.example.test")
  )
}
