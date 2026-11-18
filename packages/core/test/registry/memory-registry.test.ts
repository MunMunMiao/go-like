import { expect, test } from "bun:test"

import { background, withCancel } from "../../src/context"
import { newMemoryRegistry } from "../../src/registry/memory"
import type { ServiceInstance } from "../../src/registry/types"

const first: ServiceInstance = {
  id: "a",
  name: "orders",
  version: "1",
  metadata: { zone: "a" },
  endpoints: ["http://127.0.0.1:8080/"]
}

const second: ServiceInstance = {
  id: "b",
  name: "orders",
  version: "1",
  metadata: {},
  endpoints: ["http://127.0.0.1:8081/"]
}

test("stores, replaces, watches, and removes process-local instances", async () => {
  const registry = newMemoryRegistry({ instances: [first], watchBufferSize: 2 })
  expect(await registry.getService(background(), "missing")).toEqual([])
  expect(await registry.getService(background(), "orders")).toMatchObject([{ id: "a" }])

  const watcher = await registry.watch(background(), "orders")
  expect(await watcher.next(background())).toMatchObject([{ id: "a" }])
  await registry.register(background(), second)
  expect(await watcher.next(background())).toMatchObject([{ id: "a" }, { id: "b" }])
  await registry.deregister(background(), { ...first, endpoints: ["http://127.0.0.1:9/"] })
  expect(await watcher.next(background())).toMatchObject([{ id: "b" }])
  await registry.deregister(background(), second)
  expect(await watcher.next(background())).toEqual([])
  await registry.deregister(background(), second)
  await watcher.stop(background())

  const [ctx, cancel] = withCancel(background())
  cancel()
  await expect(registry.register(ctx, first)).rejects.toThrow()
  await expect(registry.deregister(ctx, first)).rejects.toThrow()
  await expect(registry.getService(ctx, "orders")).rejects.toThrow()
  await expect(registry.watch(ctx, "orders")).rejects.toThrow()
  expect(() => newMemoryRegistry({ watchBufferSize: 0 })).toThrow(RangeError)
  await expect(registry.getService(background(), "")).rejects.toThrow(
    "service name must be a non-empty string"
  )
  await expect(registry.watch(background(), "")).rejects.toThrow(
    "service name must be a non-empty string"
  )
})
