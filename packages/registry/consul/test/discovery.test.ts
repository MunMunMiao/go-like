import { background, withCancelCause } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import { encodeRegistration } from "../src/codec"
import { newConsulRegistry, type ConsulFetch } from "../src/index"
import { eventually, fakeAgent } from "./helpers"

/** Creates one deterministic public ServiceInstance revision. */
function instance(revision: string, id = "orders-1"): ServiceInstance {
  return {
    id,
    name: "orders",
    version: "v1",
    metadata: { revision },
    endpoints: [`http://127.0.0.1:${revision === "updated" ? 8081 : 8080}/`]
  }
}

/** Creates one provider with short deterministic blocking-query timings. */
function registry(agent = fakeAgent(), watchBufferSize = 128) {
  return newConsulRegistry({
    fetch: agent.fetch,
    address: "https://consul.example",
    waitMs: 20,
    minimumQueryIntervalMs: 2,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    watchBufferSize,
    ttlMs: 2_000
  })
}

/** Converts one encoded registration body to a detached health Service carrier. */
function carrier(body: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(body)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("encoded registration body is invalid")
  }
  const record = value as Readonly<Record<string, unknown>>
  return {
    ID: record.ID,
    Service: record.Name,
    Address: record.Address,
    Port: record.Port,
    Tags: record.Tags,
    Meta: record.Meta
  }
}

/** Creates a short-timing provider around one exact Fetch boundary. */
function registryWith(fetch: ConsulFetch) {
  return newConsulRegistry({
    fetch,
    address: "https://consul.example",
    waitMs: 20,
    minimumQueryIntervalMs: 2,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    ttlMs: 2_000
  })
}

test("getService exposes only immutable ServiceInstance snapshots", async () => {
  const provider = registry()
  await provider.register(background(), instance("initial"))
  const services = await provider.getService(background(), "orders")
  expect(services).toEqual([instance("initial")])
  expect(Object.isFrozen(services)).toBe(true)
  expect(Object.isFrozen(services[0])).toBe(true)
  await provider.deregister(background(), instance("initial"))
})

test("watch returns only complete replacement snapshots and owns stop", async () => {
  const provider = registry()
  const watcher = await provider.watch(background(), "orders")
  expect(Object.keys(watcher).sort()).toEqual(["next", "stop"])

  await provider.register(background(), instance("initial"))
  expect(await watcher.next(background())).toEqual([instance("initial")])

  await provider.register(background(), instance("updated"))
  expect(await watcher.next(background())).toEqual([instance("updated")])

  await provider.register(background(), instance("second", "orders-2"))
  expect(await watcher.next(background())).toEqual([
    instance("updated"),
    instance("second", "orders-2")
  ])

  await provider.deregister(background(), instance("updated"))
  expect(await watcher.next(background())).toEqual([instance("second", "orders-2")])
  await provider.deregister(background(), instance("second", "orders-2"))
  expect(await watcher.next(background())).toEqual([])

  await watcher.stop(background())
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "LIKEGO_WATCHER_STOPPED"
  })
})

test("watch first next returns an already-present complete snapshot", async () => {
  const provider = registry()
  await provider.register(background(), instance("initial"))
  const watcher = await provider.watch(background(), "orders")
  expect(await watcher.next(background())).toEqual([instance("initial")])
  await watcher.stop(background())
  await provider.deregister(background(), instance("initial"))
})

test("canceling one next abandons only that wait and preserves the watcher", async () => {
  const provider = registry()
  const watcher = await provider.watch(background(), "orders")
  const [ctx, cancel] = withCancelCause(background())
  const failure = new Error("caller abandoned next")
  const waiting = watcher.next(ctx)
  cancel(failure)
  await expect(waiting).rejects.toBe(failure)
  await provider.register(background(), instance("initial"))
  expect(await watcher.next(background())).toEqual([instance("initial")])
  await watcher.stop(background())
  await provider.deregister(background(), instance("initial"))
})

test("watch buffer overflow is a stable terminal provider error", async () => {
  const provider = registry(fakeAgent(), 1)
  const watcher = await provider.watch(background(), "orders")
  await provider.register(background(), instance("initial"))
  await eventually(async () => (await provider.getService(background(), "orders")).length === 1)
  await provider.register(background(), instance("updated"))
  await Bun.sleep(50)
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "LIKEGO_WATCHER_OVERFLOW",
    bufferSize: 1
  })
  await watcher.stop(background())
  await provider.deregister(background(), instance("updated"))
})

test("discovery rejects invalid names, missing cursors, and unavailable queries", async () => {
  const provider = registry()
  await expect(provider.getService(background(), "")).rejects.toThrow("non-empty")
  await expect(provider.watch(background(), "")).rejects.toThrow("non-empty")

  const missingCursor = registryWith(async function queryWithoutCursor(): Promise<Response> {
    return Response.json([])
  })
  await expect(missingCursor.getService(background(), "orders")).rejects.toThrow(
    "decimal X-Consul-Index"
  )

  const unavailable = registryWith(async function unavailableQuery(): Promise<Response> {
    return new Response(null, { status: 503 })
  })
  await expect(unavailable.watch(background(), "orders")).rejects.toMatchObject({
    code: "LIKEGO_CONSUL_HTTP",
    status: 503
  })
})

test("discovery rejects conflicting records for one logical identity", async () => {
  const first = await encodeRegistration(instance("initial"), 2_000, 60_000)
  const second = await encodeRegistration(instance("updated"), 2_000, 60_000)
  const provider = registryWith(async function conflictingHealth(): Promise<Response> {
    return Response.json([{ Service: carrier(first.body) }, { Service: carrier(second.body) }], {
      headers: { "X-Consul-Index": "1" }
    })
  })

  await expect(provider.getService(background(), "orders")).rejects.toThrow("identity collision")
})

test("watch rejects a pending caller with one terminal non-retryable failure", async () => {
  const blocked = Promise.withResolvers<Response>()
  const provider = registryWith(async function terminalWatch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    return new URL(request.url).searchParams.has("index")
      ? blocked.promise
      : Response.json([], { headers: { "X-Consul-Index": "1" } })
  })
  const watcher = await provider.watch(background(), "orders")
  const caller = withCancelCause(background())
  const waiting = watcher.next(caller[0])
  blocked.resolve(new Response(null, { status: 400 }))

  await expect(waiting).rejects.toMatchObject({ code: "LIKEGO_CONSUL_HTTP", status: 400 })
  await watcher.stop(background())
})

test("watch stops cleanly while backing off a retryable failure", async () => {
  let watchCalls = 0
  const provider = registryWith(async function retryingWatch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!new URL(request.url).searchParams.has("index")) {
      return Response.json([], { headers: { "X-Consul-Index": "1" } })
    }
    watchCalls += 1
    return new Response(null, { status: 503 })
  })
  const watcher = await provider.watch(background(), "orders")
  await eventually(() => watchCalls > 0)
  await watcher.stop(background())
})

test("watch resets a regressed Consul cursor before its next blocking query", async () => {
  const indexes: string[] = []
  const provider = registryWith(async function regressedWatch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const index = new URL(request.url).searchParams.get("index")
    if (index === null) {
      return Response.json([], { headers: { "X-Consul-Index": "2" } })
    }
    indexes.push(index)
    if (index === "2") {
      return Response.json([], { headers: { "X-Consul-Index": "1" } })
    }
    return new Promise<Response>(
      /** Retains the final blocking query until watcher ownership is stopped. */
      function blocked(_resolve, reject): void {
        request.signal.addEventListener(
          "abort",
          /** Rejects with the exact watcher stop cause. */
          function aborted(): void {
            reject(request.signal.reason)
          },
          { once: true }
        )
      }
    )
  })
  const watcher = await provider.watch(background(), "orders")
  await eventually(() => indexes.includes("0"))
  expect(indexes.slice(0, 2)).toEqual(["2", "0"])
  await watcher.stop(background())
})
