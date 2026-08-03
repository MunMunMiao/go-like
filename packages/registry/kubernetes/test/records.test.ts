import type { ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import { encodeCandidate, type ManagedSlice } from "../src/codec"
import { instances, logicalRecords, sameSnapshot } from "../src/records"

/** Creates one managed record fixture. */
async function record(value: ServiceInstance, resourceVersion: string): Promise<ManagedSlice> {
  const candidate = await encodeCandidate(value)
  return Object.freeze({
    identity: candidate.identity,
    content: candidate.content,
    serviceLabel: candidate.serviceLabel,
    name: candidate.name,
    instance: candidate.instance,
    addressType: candidate.addressType,
    addresses: candidate.addresses,
    port: candidate.port,
    owner: null,
    resourceVersion
  })
}

test("records deduplicate identities and expose deterministic snapshots", async () => {
  const orders: ServiceInstance = {
    id: "orders-1",
    name: "orders",
    version: "v1",
    metadata: {},
    endpoints: ["http://10.42.0.10:8080/"]
  }
  const users: ServiceInstance = {
    id: "users-1",
    name: "users",
    version: "v1",
    metadata: {},
    endpoints: ["https://users.example/"]
  }
  const first = await record(orders, "1")
  const duplicate = await record(orders, "2")
  const second = await record(users, "3")

  expect(logicalRecords([first, duplicate, second]).size).toBe(2)
  expect(instances([second, first], "orders")).toEqual([first.instance])
  expect(instances([second, first], null)).toEqual([first.instance, second.instance])
  expect(sameSnapshot([first.instance], [duplicate.instance])).toBe(true)
  expect(sameSnapshot([first.instance], [second.instance])).toBe(false)

  const disagreeing: ManagedSlice = Object.freeze({
    identity: first.identity,
    content: "kc-disagreeing",
    serviceLabel: first.serviceLabel,
    name: first.name,
    instance: first.instance,
    addressType: first.addressType,
    addresses: first.addresses,
    port: first.port,
    owner: null,
    resourceVersion: "4"
  })
  expect(() => logicalRecords([first, disagreeing])).toThrow("duplicate managed identity")
})
