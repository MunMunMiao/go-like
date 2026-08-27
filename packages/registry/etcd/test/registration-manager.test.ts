import { background, withCancelCause } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { expect, test } from "bun:test"

import { encodeRecord } from "../src/codec"
import { type EtcdFetch } from "../src/index"
import { captureOptions, operationOptions } from "../src/options"
import { newRegistrationManager } from "../src/registration"
import { fakeEtcd } from "./helpers"

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

/** Captures long-lived registration options without starting test-time heartbeats. */
function registrationOptions(fetch: EtcdFetch) {
  const provider = captureOptions({
    fetch,
    address: "https://etcd.example",
    ttlMs: 86_400_000
  })
  return operationOptions(provider, provider.common)
}

test("failed registrations release many distinct identity serializers", async () => {
  const etcd = fakeEtcd()
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let transactions = 0
  const fetch: EtcdFetch = async function rejectedTransaction(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/v3/kv/txn") {
      transactions += 1
      if (transactions === 1) {
        started.resolve()
        await proceed.promise
      }
      return new Response(null, { status: 403 })
    }
    return etcd.fetch(request)
  }
  const registrations = newRegistrationManager()
  const options = registrationOptions(fetch)
  const first = registrations.register(background(), instance("failed-0", "orders-0"), options)

  await started.promise
  expect(registrations.identityCount()).toBe(1)
  proceed.resolve()
  await expect(first).rejects.toMatchObject({ code: "GO_LIKE_ETCD_HTTP", status: 403 })
  for (let index = 1; index < 32; index += 1) {
    await expect(
      registrations.register(background(), instance(`failed-${index}`, `orders-${index}`), options)
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_HTTP", status: 403 })
  }
  expect(registrations.identityCount()).toBe(0)
})

test("unknown deregistrations release many distinct identity serializers", async () => {
  const etcd = fakeEtcd()
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let held = true
  const fetch: EtcdFetch = async function heldTransaction(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (held && new URL(request.url).pathname === "/v3/kv/txn") {
      held = false
      started.resolve()
      await proceed.promise
    }
    return etcd.fetch(request)
  }
  const registrations = newRegistrationManager()
  const options = registrationOptions(fetch)
  const first = registrations.deregister(background(), instance("unknown-0", "orders-0"), options)

  await started.promise
  expect(registrations.identityCount()).toBe(1)
  proceed.resolve()
  await first
  for (let index = 1; index < 32; index += 1) {
    await registrations.deregister(
      background(),
      instance(`unknown-${index}`, `orders-${index}`),
      options
    )
  }
  expect(registrations.identityCount()).toBe(0)
})

test("successful registration churn releases every identity serializer", async () => {
  const etcd = fakeEtcd()
  const registrations = newRegistrationManager()
  const options = registrationOptions(etcd.fetch)

  for (let index = 0; index < 32; index += 1) {
    const value = instance(`churn-${index}`, `orders-${index}`)
    await registrations.register(background(), value, options)
    if (index === 0) expect(registrations.identityCount()).toBe(1)
    await registrations.deregister(background(), value, options)
  }
  expect(etcd.keys()).toEqual([])
  expect(registrations.identityCount()).toBe(0)
})

test("queued same-identity replacement preserves rollback, FIFO, and generation ownership", async () => {
  const etcd = fakeEtcd()
  const deregisterStarted = Promise.withResolvers<void>()
  const continueDeregister = Promise.withResolvers<void>()
  let cancelReplacement: ((error: Error) => void) | null = null
  let holdDeregister = false
  const fetch: EtcdFetch = async function controlledTransaction(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const transaction = new URL(request.url).pathname === "/v3/kv/txn"
    if (holdDeregister && transaction) {
      holdDeregister = false
      deregisterStarted.resolve()
      await continueDeregister.promise
    }
    const response = await etcd.fetch(request)
    if (cancelReplacement !== null && transaction) {
      const cancel = cancelReplacement
      cancelReplacement = null
      cancel(new Error("replacement canceled after publish"))
    }
    return response
  }
  const registrations = newRegistrationManager()
  const options = registrationOptions(fetch)
  const initial = instance("one")
  const updated = instance("two")
  const initialWire = await encodeRecord(options.prefix, initial)
  const updatedWire = await encodeRecord(options.prefix, updated)
  await registrations.register(background(), initial, options)
  expect(registrations.identityCount()).toBe(1)

  const caller = withCancelCause(background())
  const failure = new Error("replacement canceled after publish")
  cancelReplacement = caller[1]
  await expect(registrations.register(caller[0], updated, options)).rejects.toMatchObject({
    message: failure.message
  })
  expect(etcd.entry(initialWire.key)?.value).toBe(initialWire.value)

  holdDeregister = true
  const deregistration = registrations.deregister(background(), initial, options)
  await deregisterStarted.promise
  const replacement = registrations.register(background(), updated, options)
  expect(etcd.entry(initialWire.key)?.value).toBe(initialWire.value)
  expect(registrations.identityCount()).toBe(1)

  continueDeregister.resolve()
  await Promise.all([deregistration, replacement])
  expect(etcd.entry(updatedWire.key)?.value).toBe(updatedWire.value)
  expect(registrations.identityCount()).toBe(1)

  await registrations.deregister(background(), updated, options)
  expect(etcd.keys()).toEqual([])
  expect(registrations.identityCount()).toBe(0)
})
