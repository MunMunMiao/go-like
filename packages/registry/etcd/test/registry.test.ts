import { background } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import { newEtcdRegistry, type EtcdFetch } from "../src/index"
import { eventually, fakeEtcd } from "./helpers"

/** Creates one immutable ServiceInstance revision. */
function instance(endpoint = "http://127.0.0.1:8080/"): ServiceInstance {
  return {
    id: "orders-1",
    name: "orders",
    version: "v1",
    metadata: { region: "east" },
    endpoints: [endpoint]
  }
}

test("register, update, discover, and deregister use the provider-neutral contract", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  expect(await registry.register(background(), instance())).toBeUndefined()
  expect(await registry.getService(background(), "orders")).toEqual([instance()])
  const updated = instance("http://127.0.0.1:8081/")
  await registry.register(background(), updated)
  expect(etcd.keys()).toHaveLength(1)
  expect(await registry.getService(background(), "orders")).toEqual([updated])
  expect(await registry.deregister(background(), updated)).toBeUndefined()
  expect(etcd.keys()).toEqual([])
})

test("lost transaction response is accepted only after exact lease readback", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  etcd.loseNextTxnResponse()
  await registry.register(background(), instance())
  expect(etcd.keys()).toHaveLength(1)
  expect(await registry.getService(background(), "orders")).toEqual([instance()])
  await registry.deregister(background(), instance())
})

test("lease expiry restores the same deterministic key with a fresh private lease", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({
    fetch: etcd.fetch,
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 10,
    ttlMs: 2_000
  })
  await registry.register(background(), instance())
  const key = etcd.keys()[0]
  if (key === undefined) throw new Error("registered key is missing")
  const lease = etcd.entry(key)?.lease
  etcd.expireLeases()
  await eventually(
    () => etcd.entry(key)?.lease !== undefined && etcd.entry(key)?.lease !== lease,
    3_000
  )
  expect(await registry.getService(background(), "orders")).toEqual([instance()])
  await registry.deregister(background(), instance())
})

test("watch emits complete replacement snapshots across update and deregister", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({
    fetch: etcd.fetch,
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 10
  })
  const watcher = await registry.watch(background(), "orders")
  await registry.register(background(), instance())
  expect(await watcher.next(background())).toEqual([instance()])
  const updated = instance("http://127.0.0.1:8081/")
  await registry.register(background(), updated)
  expect(await watcher.next(background())).toEqual([updated])
  etcd.compactNextWatch()
  await Bun.sleep(20)
  await registry.deregister(background(), updated)
  expect(await watcher.next(background())).toEqual([])
  await watcher.stop(background())
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "LIKEGO_WATCHER_STOPPED"
  })
})

test("malformed managed bytes fail query and watch admission closed", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  etcd.putRaw("/likego/registry/v1/records/not-managed", "not-json")
  await expect(registry.getService(background(), "orders")).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
  await expect(registry.watch(background(), "orders")).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
})

test("HTTP and token-bearing transport errors never expose credential bytes", async () => {
  const secret = "never-reflect-this"
  const statusFetch: EtcdFetch = async function statusFetch(): Promise<Response> {
    return new Response(null, { status: 503 })
  }
  const statusRegistry = newEtcdRegistry({ fetch: statusFetch, address: "https://etcd.example" })
  await expect(statusRegistry.getService(background(), "orders")).rejects.toMatchObject({
    code: "LIKEGO_ETCD_HTTP",
    status: 503
  })

  const secretFetch: EtcdFetch = async function secretFetch(): Promise<Response> {
    throw new Error(`request rejected with ${secret}`)
  }
  const secretRegistry = newEtcdRegistry({
    fetch: secretFetch,
    address: "https://etcd.example",
    token: secret
  })
  try {
    await secretRegistry.getService(background(), "orders")
    throw new Error("secret-bearing request unexpectedly fulfilled")
  } catch (error) {
    expect(error).toMatchObject({ code: "LIKEGO_ETCD_TRANSPORT" })
    expect(String(error)).not.toContain(secret)
    expect(String(error instanceof Error ? error.cause : error)).not.toContain(secret)
  }
})
