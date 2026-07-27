import { background, withCancelCause } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import { newEtcdRegistry } from "../src/index"
import { eventually, fakeEtcd } from "./helpers"

/** Creates one complete ServiceInstance revision. */
function instance(revision: string, id = "orders-1"): ServiceInstance {
  return {
    id,
    name: "orders",
    version: "v1",
    metadata: { revision },
    endpoints: [`http://127.0.0.1:${revision === "one" ? "8080" : "8081"}/`]
  }
}

test("failed admission revokes its provisional lease and leaves no record", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  etcd.failNext("/v3/kv/txn", 403)
  await expect(registry.register(background(), instance("one"))).rejects.toMatchObject({
    code: "LIKEGO_ETCD_HTTP",
    status: 403
  })
  expect(etcd.keys()).toEqual([])
})

test("failed update keeps the prior accepted immutable record", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  await registry.register(background(), instance("one"))
  etcd.failNext("/v3/kv/txn", 403)
  await expect(registry.register(background(), instance("two"))).rejects.toMatchObject({
    code: "LIKEGO_ETCD_HTTP",
    status: 403
  })
  expect(await registry.getService(background(), "orders")).toEqual([instance("one")])
  await registry.deregister(background(), instance("one"))
})

test("heartbeat retries availability loss and keeps private ownership alive", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({
    fetch: etcd.fetch,
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 4,
    ttlMs: 2_000
  })
  etcd.failKeepAlive(1, 503)
  etcd.failKeepAlive(2, 503)
  await registry.register(background(), instance("one"))
  await eventually(
    () =>
      etcd.requests.filter(function keepAlive(request) {
        return new URL(request.url).pathname === "/v3/lease/keepalive"
      }).length >= 3,
    3_000
  )
  expect(await registry.getService(background(), "orders")).toEqual([instance("one")])
  await registry.deregister(background(), instance("one"))
})

test("deregistering a stale value uses the locally active generation", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  await registry.register(background(), instance("one"))
  await registry.register(background(), instance("two"))
  await registry.deregister(background(), instance("one"))
  expect(await registry.getService(background(), "orders")).toEqual([])
})

test("caller cancellation after publish restores the prior local generation", async () => {
  const etcd = fakeEtcd()
  const [ctx, cancel] = withCancelCause(background())
  const failure = new Error("registration caller canceled")
  let cancelTransaction = false
  const registry = newEtcdRegistry({
    fetch: async function fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const response = await etcd.fetch(request)
      if (cancelTransaction && new URL(request.url).pathname === "/v3/kv/txn") {
        cancelTransaction = false
        cancel(failure)
      }
      return response
    },
    address: "https://etcd.example"
  })
  await registry.register(background(), instance("one"))
  cancelTransaction = true
  await expect(registry.register(ctx, instance("two"))).rejects.toBe(failure)
  expect(await registry.getService(background(), "orders")).toEqual([instance("one")])
  await registry.deregister(background(), instance("one"))
})

test("caller cancellation after first publish removes its unaccepted record", async () => {
  const etcd = fakeEtcd()
  const caller = withCancelCause(background())
  const failure = new Error("first registration caller canceled")
  let cancelTransaction = true
  const registry = newEtcdRegistry({
    address: "https://etcd.example",
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const response = await etcd.fetch(request)
      if (cancelTransaction && new URL(request.url).pathname === "/v3/kv/txn") {
        cancelTransaction = false
        caller[1](failure)
      }
      return response
    }
  })

  await expect(registry.register(caller[0], instance("one"))).rejects.toBe(failure)
  expect(etcd.keys()).toEqual([])
})

test("registration aggregates a failed cleanup after caller cancellation", async () => {
  const etcd = fakeEtcd()
  etcd.failPathCall("/v3/kv/txn", 2, 403)
  const caller = withCancelCause(background())
  const primary = new Error("registration canceled after publish")
  let cancelTransaction = true
  const registry = newEtcdRegistry({
    address: "https://etcd.example",
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const response = await etcd.fetch(request)
      if (cancelTransaction && new URL(request.url).pathname === "/v3/kv/txn") {
        cancelTransaction = false
        caller[1](primary)
      }
      return response
    }
  })

  const failure: unknown = await registry.register(caller[0], instance("one")).catch(
    /** Captures the exact ordered rollback failure. */
    function capture(value: unknown): unknown {
      return value
    }
  )
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors[0]).toBe(primary)
  expect((failure as AggregateError).errors[1]).toMatchObject({
    code: "LIKEGO_ETCD_HTTP",
    status: 403
  })
  expect(etcd.keys()).toEqual([])
})

test("best-effort lease retirement cannot fail a completed deregistration", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  await registry.register(background(), instance("one"))
  etcd.failNext("/v3/lease/revoke", 503)

  await expect(registry.deregister(background(), instance("one"))).resolves.toBeUndefined()
  expect(etcd.keys()).toEqual([])
})

test("private ownership yields when an expired identity is claimed by another publisher", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({
    fetch: etcd.fetch,
    address: "https://etcd.example",
    ttlMs: 2_000
  })
  await registry.register(background(), instance("one"))
  const key = etcd.keys()[0]
  if (key === undefined) throw new Error("registered etcd key is missing")
  etcd.expireLeases()
  etcd.putRaw(key, "foreign")

  await eventually(
    () =>
      etcd.requests.filter(function transaction(request) {
        return new URL(request.url).pathname === "/v3/kv/txn"
      }).length >= 2,
    2_500
  )
  await registry.deregister(background(), instance("one"))
  expect(etcd.entry(key)?.value).toBe("foreign")
})

test("private lease renewal reports retryable and terminal failures without logger ownership", async () => {
  const retryEtcd = fakeEtcd()
  const terminalEtcd = fakeEtcd()
  retryEtcd.failKeepAlive(1, 503)
  terminalEtcd.failKeepAlive(1, 403)
  const levels: string[] = []
  const retryNotifications: Error[] = []
  const terminalNotifications: { readonly error: Error; readonly service: ServiceInstance }[] = []
  const retrying = newEtcdRegistry({
    fetch: retryEtcd.fetch,
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 4,
    ttlMs: 2_000,
    logger: {
      log(level): void {
        levels.push(level)
      }
    },
    onRegistrationError(error): void {
      retryNotifications.push(error)
    }
  })
  const terminal = newEtcdRegistry({
    fetch: terminalEtcd.fetch,
    address: "https://etcd.example",
    ttlMs: 2_000,
    logger: {
      log(level): void {
        levels.push(level)
        throw new Error("borrowed logger failed")
      }
    },
    onRegistrationError(error, service): Promise<void> {
      terminalNotifications.push({ error, service })
      return Promise.reject(new Error("borrowed terminal observer failed"))
    }
  })
  await Promise.all([
    retrying.register(background(), instance("one")),
    terminal.register(background(), instance("one"))
  ])

  await eventually(
    () => levels.includes("warn") && levels.includes("error") && terminalNotifications.length === 1,
    2_500
  )
  expect(retryNotifications).toEqual([])
  expect(terminalNotifications[0]?.error).toMatchObject({
    code: "LIKEGO_ETCD_HTTP",
    status: 403
  })
  expect(terminalNotifications[0]?.service).toEqual(instance("one"))
  expect(Object.isFrozen(terminalNotifications[0]?.service)).toBe(true)
  await Promise.all([
    retrying.deregister(background(), instance("one")),
    terminal.deregister(background(), instance("one"))
  ])
})

test("a late retryable lease renewal from a retired generation cannot notify its replacement", async () => {
  const etcd = fakeEtcd()
  const oldRenewalStarted = Promise.withResolvers<void>()
  const continueOldRenewal = Promise.withResolvers<void>()
  const notifications: ServiceInstance[] = []
  let delayedOldRenewal = false
  let oldLease: string | null = null
  const registry = newEtcdRegistry({
    fetch: async function generationFetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname === "/v3/lease/keepalive") {
        const body: unknown = await request.clone().json()
        const lease =
          typeof body === "object" && body !== null && !Array.isArray(body)
            ? Object.getOwnPropertyDescriptor(body, "ID")?.value
            : undefined
        if (typeof lease !== "string") throw new Error("keepalive lease ID is missing")
        if (oldLease === null) oldLease = lease
        if (lease !== oldLease) return new Response(null, { status: 403 })
        if (!delayedOldRenewal) {
          delayedOldRenewal = true
          oldRenewalStarted.resolve()
          await continueOldRenewal.promise
          return new Response(null, { status: 503 })
        }
      }
      return etcd.fetch(request)
    },
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 4,
    ttlMs: 2_000,
    onRegistrationError(_error, service): void {
      notifications.push(service)
    }
  })
  await registry.register(background(), instance("one"))
  await oldRenewalStarted.promise

  const replacement = registry.register(background(), instance("two"))
  expect(notifications).toEqual([])
  continueOldRenewal.resolve()
  await replacement

  await eventually(() => notifications.length === 1, 2_500)
  expect(notifications).toEqual([instance("two")])
  await registry.deregister(background(), instance("two"))
})
