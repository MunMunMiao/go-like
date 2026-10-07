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

test("returns a published snapshot unchanged and publishes every other array afresh", () => {
  const source: ServiceInstance = {
    id: "one",
    name: "catalog",
    version: "v1",
    metadata: { zone: "a" },
    endpoints: ["memory://catalog", "memory://catalog-two"]
  }
  const values = [source]
  const published = snapshotServiceInstances(values)

  // Trusting the brand is only safe because everything reachable from it is frozen.
  expect(Object.isFrozen(published)).toBeTrue()
  for (const instance of published) {
    expect(Object.isFrozen(instance)).toBeTrue()
    expect(Object.isFrozen(instance.metadata)).toBeTrue()
    expect(Object.isFrozen(instance.endpoints)).toBeTrue()
  }
  expect(snapshotServiceInstances(published)).toBe(published)
  // An unpublished caller array is copied on every call, never returned or remembered.
  const again = snapshotServiceInstances(values)
  expect(again).not.toBe(values)
  expect(again).not.toBe(published)
  expect(again).toEqual(published)
})

test("copies and validates every array it did not publish", () => {
  const valid: ServiceInstance = {
    id: "one",
    name: "catalog",
    version: "",
    metadata: {},
    endpoints: ["memory://catalog"]
  }
  const published = snapshotServiceInstances([valid])

  // A frozen caller array is not a published snapshot.
  const frozen = Object.freeze([valid])
  expect(snapshotServiceInstances(frozen)).not.toBe(frozen)
  expect(snapshotServiceInstances(frozen)).toEqual([valid])

  // An array derived from published members is copied, republished, and then trusted itself.
  const derived = Object.freeze(Array.from(published))
  const republished = snapshotServiceInstances(derived)
  expect(republished).not.toBe(derived)
  expect(republished).not.toBe(published)
  expect(republished).toEqual(published)
  expect(snapshotServiceInstances(republished)).toBe(republished)

  // Published members give a derived array no credit: its other members and shape are checked.
  const forged = { ...valid, id: "two", endpoints: ["relative"] }
  expect(() => snapshotServiceInstances(Object.freeze([...published, forged]))).toThrow(TypeError)
  expect(() => snapshotServiceInstances([...published, ...published])).toThrow(TypeError)
  expect(() => snapshotServiceInstances(Object.freeze([...published, ...published]))).toThrow(
    TypeError
  )
  expect(() => snapshotServiceInstances({ ...published } as never)).toThrow(TypeError)
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
