import type { ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import { decodeRecord, encodeRecord } from "../src/codec"
import { instances, type ManagedDecodedRecord } from "../src/records"

/** Creates one verified managed record for direct snapshot tests. */
async function managed(value: ServiceInstance): Promise<ManagedDecodedRecord> {
  const encoded = await encodeRecord("/likego/registry/v1/", value)
  const decoded = await decodeRecord("/likego/registry/v1/", encoded.key, encoded.value)
  return Object.freeze({
    key: encoded.key,
    value: encoded.value,
    lease: "1",
    identity: decoded.identity,
    content: decoded.content,
    instance: decoded.instance
  })
}

test("instances filter and sort complete ServiceInstance records", async () => {
  const orders = await managed({
    id: "orders-1",
    name: "orders",
    version: "v1",
    metadata: {},
    endpoints: ["http://127.0.0.1:8080/"]
  })
  const alpha = await managed({
    id: "alpha-1",
    name: "alpha",
    version: "v1",
    metadata: {},
    endpoints: ["http://127.0.0.1:8081/"]
  })
  expect(instances([orders, alpha]).map((value) => value.name)).toEqual(["alpha", "orders"])
  expect(instances([orders, alpha], "orders")).toEqual([orders.instance])
})

test("instances reject conflicting records for one deterministic identity", async () => {
  const first = await managed({
    id: "orders-1",
    name: "orders",
    version: "v1",
    metadata: {},
    endpoints: ["http://127.0.0.1:8080/"]
  })
  const collision: ManagedDecodedRecord = Object.freeze({
    ...first,
    key: `${first.key}-collision`,
    content: "lc-collision"
  })
  expect(() => instances([first, collision])).toThrow("identity collision")
})
