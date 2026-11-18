import { background } from "@go-like/core/context"
import type { Registry, ServiceInstance } from "@go-like/core/registry"
import { expect, test } from "bun:test"

import { newConsulRegistry } from "../../src/registry/index"
import { fakeAgent } from "./helpers"
import { newConsulClient, type ConsulClientOptions } from "../../src/index"
type ConsulFetch = ConsulClientOptions["fetch"]

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: { region: "east" },
  endpoints: ["http://127.0.0.1:8080/"]
}

test("newConsulRegistry is the sole constructor and structurally satisfies Registry", () => {
  const fetch: ConsulFetch = async function accepted(): Promise<Response> {
    return new Response(null)
  }
  const registry: Registry = newConsulRegistry(
    newConsulClient({
      fetch,
      address: "https://consul.example"
    })
  )
  expect(Object.keys(registry).sort()).toEqual(["deregister", "getService", "register", "watch"])
})

test("public operations use only ServiceInstance and replacement-snapshot contracts", async () => {
  const agent = fakeAgent()
  const registry = newConsulRegistry(
    newConsulClient({
      fetch: agent.fetch,
      address: "https://consul.example"
    }),
    {
      ttlMs: 2_000
    }
  )
  const watcher = await registry.watch(background(), instance.name)
  expect(await registry.register(background(), instance)).toBeUndefined()
  expect(await watcher.next(background())).toEqual([instance])
  expect(await registry.getService(background(), instance.name)).toEqual([instance])
  expect(await registry.deregister(background(), instance)).toBeUndefined()
  expect(await watcher.next(background())).toEqual([])
  await watcher.stop(background())
})
