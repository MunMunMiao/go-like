import { expect, test } from "bun:test"

import { newEtcdRegistry, type EtcdFetch } from "../src/index"

const accepted: EtcdFetch = async function acceptedFetch(): Promise<Response> {
  return Response.json({})
}

test("constructor captures and validates common Registry options", () => {
  const sink = { log(): void {} }
  const registry = newEtcdRegistry({
    fetch: accepted,
    address: "https://etcd.example/",
    logger: sink,
    timeoutMs: 25
  })
  expect(Object.keys(registry).sort()).toEqual(["deregister", "getService", "register", "watch"])
})

test("constructor rejects unsafe provider options without reflecting token", () => {
  const secret = "never-reflect-this"
  const invalid: readonly (() => unknown)[] = [
    () => newEtcdRegistry(null as never),
    () => newEtcdRegistry({ fetch: null as never, address: "https://etcd.example" }),
    () => newEtcdRegistry({ fetch: accepted, address: `not a url ${secret}` }),
    () => newEtcdRegistry({ fetch: accepted, address: `https://user:${secret}@etcd.example` }),
    () => newEtcdRegistry({ fetch: accepted, address: "https://etcd.example/v3" }),
    () => newEtcdRegistry({ fetch: accepted, address: "https://etcd.example", prefix: "relative" }),
    () => newEtcdRegistry({ fetch: accepted, address: "https://etcd.example", token: "bad\r\n" }),
    () => newEtcdRegistry({ fetch: accepted, address: "https://etcd.example", retryInitialMs: 0 }),
    () =>
      newEtcdRegistry({
        fetch: accepted,
        address: "https://etcd.example",
        retryInitialMs: 10,
        retryMaximumMs: 9
      }),
    () =>
      newEtcdRegistry({
        fetch: accepted,
        address: "https://etcd.example",
        watchBufferSize: 0
      }),
    () =>
      newEtcdRegistry({
        fetch: accepted,
        address: "https://etcd.example",
        watchBufferSize: 4_097
      }),
    () => newEtcdRegistry({ fetch: accepted, address: "https://etcd.example", ttlMs: 1_999 }),
    () => newEtcdRegistry({ fetch: accepted, address: "https://etcd.example", ttlMs: 86_400_001 })
  ]
  for (const construct of invalid) {
    expect(construct).toThrow()
    try {
      construct()
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  }
})
