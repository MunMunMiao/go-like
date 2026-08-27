import { describe, expect, test } from "bun:test"

import { background, withCancelCause, withTimeout } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"

import { queryTimeout, ttl, watchBufferSize } from "../src/options"
import { instanceRecords, parseInstanceAddress, parseInstanceAddresses } from "../src/registration"
import { newMDNSRegistry as createMDNSRegistry } from "../src/registry"
import { newMemoryMDNSNetwork } from "../src/testing"
import type { MDNSHost, MDNSOption } from "../src/types"

/** Creates one short-TTL mDNS provider for deterministic lifecycle tests. */
function newMDNSRegistry(host: MDNSHost, ...options: readonly MDNSOption[]) {
  return createMDNSRegistry(host, ...options, ttl(2_000))
}

/** Creates one deterministic provider fixture. */
function instance(endpoint = "http://127.0.0.1:8080", version = "v1"): ServiceInstance {
  return {
    id: "node-1",
    name: "orders",
    version,
    metadata: { environment: "test" },
    endpoints: [new URL(endpoint).toString()]
  }
}

/** Waits for one Watcher snapshot under a bounded test Context. */
async function next(
  watcher: Awaited<ReturnType<ReturnType<typeof newMDNSRegistry>["watch"]>>
): Promise<readonly ServiceInstance[]> {
  const [ctx, cancel] = withTimeout(background(), 2_000)
  try {
    return await watcher.next(ctx)
  } finally {
    cancel()
  }
}

describe("mDNS registration and portable provider", () => {
  test("parses only IP-literal absolute endpoints with one shared SRV port", () => {
    expect(parseInstanceAddress("http://127.0.0.1:8080")).toEqual({
      family: "ipv4",
      address: "127.0.0.1",
      port: 8080
    })
    expect(parseInstanceAddress("https://[::1]")).toEqual({
      family: "ipv6",
      address: "::1",
      port: 443
    })
    expect(() => parseInstanceAddress("127.0.0.1:8080")).toThrow(TypeError)
    expect(() => parseInstanceAddress("http://host.test:8080")).toThrow()
    expect(() => parseInstanceAddress("custom://127.0.0.1")).toThrow(TypeError)
    expect(() =>
      parseInstanceAddresses({
        ...instance(),
        endpoints: ["http://127.0.0.1:8080", "http://127.0.0.1:8081"]
      })
    ).toThrow(TypeError)
    expect(
      parseInstanceAddresses({
        ...instance(),
        endpoints: ["http://127.0.0.1:8080", "http://[::1]:8080"]
      })
    ).toEqual([
      { family: "ipv4", address: "127.0.0.1", port: 8080 },
      { family: "ipv6", address: "::1", port: 8080 }
    ])
  })

  test("builds shared discovery records and unique instance records", async () => {
    const records = await instanceRecords(instance(), "go-like.", 120, 65_536)
    expect(records.map((record) => [record.type, record.flush])).toEqual([
      ["PTR", false],
      ["TXT", false],
      ["PTR", false],
      ["SRV", true],
      ["TXT", true],
      ["A", true]
    ])
    expect(records[0]?.name).toBe("_services.go-like.")
    expect(records[3]?.name.startsWith("li-")).toBe(true)
    expect(records[3]?.ttl).toBe(120)
    await expect(instanceRecords(instance(), "go-like", 1, 65_536)).rejects.toThrow(TypeError)
    await expect(instanceRecords(instance(), "go-like.", -1, 65_536)).rejects.toThrow(RangeError)
  })

  test("registers, discovers, replaces, watches, and deregisters", async () => {
    const network = newMemoryMDNSNetwork()
    const registry = newMDNSRegistry(network.host("publisher"), queryTimeout(10))
    const observer = newMDNSRegistry(network.host("observer"), queryTimeout(10), watchBufferSize(8))
    const watcher = await observer.watch(background(), "orders")
    const initial = instance()
    const updated = instance("http://127.0.0.1:8081", "v2")

    await registry.register(background(), initial)
    expect(await next(watcher)).toEqual([initial])
    expect(await observer.getService(background(), "orders")).toEqual([initial])

    await registry.register(background(), updated)
    expect(await next(watcher)).toEqual([updated])
    expect(await observer.getService(background(), "orders")).toEqual([updated])

    await registry.deregister(background(), updated)
    expect(await next(watcher)).toEqual([])
    await watcher.stop(background())
    expect(network.activeSockets()).toBe(0)
  })

  test("preserves Context cancellation without leaking sockets", async () => {
    const network = newMemoryMDNSNetwork()
    const registry = newMDNSRegistry(network.host("canceled"), queryTimeout(5))
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("admission canceled")
    cancel(failure)
    await expect(registry.register(ctx, instance())).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("rejects a conflicting publisher for the same instance identity", async () => {
    const network = newMemoryMDNSNetwork()
    const first = newMDNSRegistry(network.host("first"), queryTimeout(15))
    const second = newMDNSRegistry(network.host("second"), queryTimeout(15))
    const current = instance()
    await first.register(background(), current)
    await expect(
      second.register(background(), instance("http://127.0.0.1:9090"))
    ).rejects.toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
    await first.deregister(background(), current)
    expect(network.activeSockets()).toBe(0)
  })
})
