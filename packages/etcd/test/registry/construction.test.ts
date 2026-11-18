import { expect, test } from "bun:test"

import { newEtcdRegistry } from "../../src/registry/index"
import { newEtcdClient } from "../../src/index"
import type { Fetch } from "@go-like/core/fetch"

const accepted: Fetch = async function acceptedFetch(): Promise<Response> {
  return Response.json({})
}

test("constructor captures and validates common Registry options", () => {
  const registry = newEtcdRegistry(
    newEtcdClient({
      fetch: accepted,
      address: "https://etcd.example/"
    }),
    {
      timeoutMs: 25
    }
  )
  expect(Object.keys(registry).sort()).toEqual(["deregister", "getService", "register", "watch"])
})

test("constructor rejects unsafe provider options without reflecting token", () => {
  const secret = "never-reflect-this"
  const invalid: readonly (() => unknown)[] = [
    () => newEtcdRegistry(null as never),
    () =>
      newEtcdRegistry(
        newEtcdClient({ fetch: accepted, address: "https://etcd.example" }),
        null as never
      ),
    () => newEtcdRegistry(newEtcdClient({ fetch: null as never, address: "https://etcd.example" })),
    () => newEtcdRegistry(newEtcdClient({ fetch: accepted, address: `not a url ${secret}` })),
    () =>
      newEtcdRegistry(
        newEtcdClient({ fetch: accepted, address: `https://user:${secret}@etcd.example` })
      ),
    () => newEtcdRegistry(newEtcdClient({ fetch: accepted, address: "https://etcd.example/v3" })),
    () =>
      newEtcdRegistry(newEtcdClient({ fetch: accepted, address: "https://etcd.example" }), {
        prefix: "relative"
      }),
    () =>
      newEtcdRegistry(
        newEtcdClient({ fetch: accepted, address: "https://etcd.example", token: "bad\r\n" })
      ),
    () =>
      newEtcdRegistry(newEtcdClient({ fetch: accepted, address: "https://etcd.example" }), {
        retryInitialMs: 0
      }),
    () =>
      newEtcdRegistry(
        newEtcdClient({
          fetch: accepted,
          address: "https://etcd.example"
        }),
        {
          retryInitialMs: 10,
          retryMaximumMs: 9
        }
      ),
    () =>
      newEtcdRegistry(
        newEtcdClient({
          fetch: accepted,
          address: "https://etcd.example"
        }),
        {
          watchBufferSize: 0
        }
      ),
    () =>
      newEtcdRegistry(
        newEtcdClient({
          fetch: accepted,
          address: "https://etcd.example"
        }),
        {
          watchBufferSize: 4_097
        }
      ),
    () =>
      newEtcdRegistry(newEtcdClient({ fetch: accepted, address: "https://etcd.example" }), {
        ttlMs: 1_999
      }),
    () =>
      newEtcdRegistry(newEtcdClient({ fetch: accepted, address: "https://etcd.example" }), {
        ttlMs: 86_400_001
      })
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
