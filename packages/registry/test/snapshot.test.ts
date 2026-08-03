import { expect, test } from "bun:test"

import { type ServiceInstance } from "../src/index"
import { snapshotServiceInstance, snapshotServiceInstances } from "../src/provider"

test("snapshots one Kratos-style service instance defensively", () => {
  const metadata = { zone: "a", revision: "one" }
  const endpoints = ["http://127.0.0.1:8000"]
  const input: ServiceInstance = {
    id: "catalog-1",
    name: "catalog",
    version: "v1",
    metadata,
    endpoints
  }
  const snapshot = snapshotServiceInstance(input)
  metadata.zone = "mutated"
  endpoints[0] = "mutated"

  expect(snapshot).toEqual({
    id: "catalog-1",
    name: "catalog",
    version: "v1",
    metadata: { revision: "one", zone: "a" },
    endpoints: ["http://127.0.0.1:8000/"]
  })
  expect(Object.isFrozen(snapshot)).toBeTrue()
  expect(Object.isFrozen(snapshot.metadata)).toBeTrue()
  expect(Object.isFrozen(snapshot.endpoints)).toBeTrue()
  expect(
    snapshotServiceInstance({ ...input, endpoints: ["https://example.test/rpc?"] }).endpoints
  ).toEqual(["https://example.test/rpc?"])
})

test("snapshots complete replacement arrays", () => {
  const service: ServiceInstance = {
    id: "one",
    name: "catalog",
    version: "",
    metadata: {},
    endpoints: ["memory://catalog"]
  }
  const values = [service]
  const snapshot = snapshotServiceInstances(values)
  values.length = 0
  expect(snapshot).toEqual([service])
  expect(Object.isFrozen(snapshot)).toBeTrue()
})

test("canonicalizes protocol-neutral endpoints and service order", () => {
  const snapshot = snapshotServiceInstances([
    {
      id: "two",
      name: "catalog",
      version: "",
      metadata: {},
      endpoints: ["nats://catalog.internal", "memory://catalog", "nats://catalog.internal"]
    },
    {
      id: "one",
      name: "catalog",
      version: "",
      metadata: {},
      endpoints: ["grpc://catalog.internal"]
    }
  ])
  expect(snapshot.map((instance) => instance.id)).toEqual(["one", "two"])
  expect(snapshot[1]?.endpoints).toEqual(["memory://catalog", "nats://catalog.internal"])
})

test("rejects malformed service instances", () => {
  const valid: ServiceInstance = {
    id: "one",
    name: "catalog",
    version: "",
    metadata: {},
    endpoints: ["memory://catalog"]
  }
  expect(snapshotServiceInstance({ ...valid, name: "catalog-\u{1f408}" }).name).toBe(
    "catalog-\u{1f408}"
  )
  const invalid: unknown[] = [
    null,
    {},
    { ...valid, name: "" },
    { ...valid, name: "\ud800" },
    { ...valid, name: "\udc00" },
    { ...valid, endpoints: null },
    { ...valid, endpoints: [""] },
    { ...valid, endpoints: ["relative"] },
    { ...valid, endpoints: ["https://user:secret@example.test"] },
    { ...valid, endpoints: ["https://example.test/#"] },
    { ...valid, endpoints: ["https://example.test/#fragment"] },
    { ...valid, metadata: [] },
    { ...valid, metadata: new Map() },
    { ...valid, metadata: { zone: 1 } }
  ]
  for (const value of invalid) {
    expect(() => snapshotServiceInstance(value as never)).toThrow(TypeError)
  }
  expect(() => snapshotServiceInstances(null as never)).toThrow(TypeError)
  expect(() => snapshotServiceInstances([valid, valid])).toThrow(TypeError)
  expect(() => snapshotServiceInstances([valid, { ...valid, version: "v2" }])).toThrow(TypeError)
})
