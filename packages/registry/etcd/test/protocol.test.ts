import type { ServiceInstance } from "@go-like/registry"
import { expect, test } from "bun:test"

import { encodeBytes, encodeRecord, type EncodedRecord } from "../src/codec"
import { captureOptions, operationOptions, type OperationOptions } from "../src/options"
import {
  grantLease,
  keepAlive,
  publish,
  range,
  remove,
  restore,
  revokeLease
} from "../src/protocol"
import type { EtcdFetch } from "../src/types"

interface Step {
  /** Resolves one exact scripted Fetch call. */
  (request: Request): Response | Promise<Response>
}

/** Creates one deterministic operation snapshot from ordered Fetch steps. */
function scripted(...steps: readonly Step[]): OperationOptions {
  const pending = Array.from(steps)
  const fetch: EtcdFetch = async function scriptedFetch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const step = pending.shift()
    if (step === undefined) throw new Error("scripted Fetch step is missing")
    return await step(request)
  }
  const captured = captureOptions({ fetch, address: "https://etcd.example" })
  return operationOptions(captured, captured.common, 50)
}

/** Returns one successful JSON response step. */
function json(value: unknown, status = 200): Step {
  return function response(): Response {
    return Response.json(value, { status })
  }
}

/** Returns one transport rejection step. */
function rejected(message: string): Step {
  return function response(): never {
    throw new Error(message)
  }
}

/** Creates one gateway range response. */
function rangeResponse(records: readonly object[]): object {
  return { header: { revision: "1" }, kvs: records, count: String(records.length) }
}

/** Creates one exact gateway KV carrier. */
function kv(key: string, value: string, lease: string): object {
  return {
    key: encodeBytes(key),
    value: encodeBytes(value),
    lease,
    mod_revision: "1"
  }
}

/** Encodes one protocol fixture. */
function record(endpoint = "http://127.0.0.1:8080/"): Promise<EncodedRecord> {
  const instance: ServiceInstance = {
    id: "node-1",
    name: "protocol",
    version: "v1",
    metadata: {},
    endpoints: [endpoint]
  }
  return encodeRecord("/go-like/registry/v1/", instance)
}

test("lease and range parsing reject malformed gateway carriers", async () => {
  const signal = new AbortController().signal
  await expect(grantLease(scripted(json([])), 2, signal)).rejects.toThrow("response is invalid")
  await expect(grantLease(scripted(json({ ID: "invalid", TTL: "2" })), 2, signal)).rejects.toThrow(
    "decimal int64"
  )
  await expect(grantLease(scripted(json({ ID: "0", TTL: "2" })), 2, signal)).rejects.toThrow(
    "must be non-zero"
  )
  await expect(grantLease(scripted(json({ ID: "1", TTL: "-1" })), 2, signal)).rejects.toThrow(
    "non-positive TTL"
  )
  await expect(
    keepAlive(scripted(json({ result: { ID: "2", TTL: "1" } })), "1", signal)
  ).rejects.toThrow("another lease ID")
  expect(
    await keepAlive(scripted(json({ result: { ID: "1", TTL: "0" } })), "1", signal)
  ).toBeFalse()
  await expect(revokeLease(scripted(json({})), "1", signal)).rejects.toThrow("omitted its header")
  await expect(
    range(scripted(json({ header: { revision: "1" }, kvs: {} })), "key", false, signal)
  ).rejects.toThrow("kvs must be an array")
  await expect(range(scripted(json(rangeResponse([[]]))), "key", false, signal)).rejects.toThrow(
    "invalid KV"
  )
  await expect(
    range(
      scripted(
        json(
          rangeResponse([{ key: 1, value: encodeBytes("value"), lease: "1", mod_revision: "1" }])
        )
      ),
      "key",
      false,
      signal
    )
  ).rejects.toThrow("bytes fields are invalid")
})

test("publish accepts lost response only after exact ownership readback", async () => {
  const signal = new AbortController().signal
  const current = await record()
  await publish(
    scripted(rejected("lost"), json(rangeResponse([kv(current.key, current.value, "1")]))),
    current,
    "1",
    signal
  )
  await expect(
    publish(scripted(json({}), json(rangeResponse([]))), current, "1", signal)
  ).rejects.toThrow("did not establish exact ownership")
  await expect(
    publish(scripted(rejected("lost"), json(rangeResponse([]))), current, "1", signal)
  ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_TRANSPORT" })
})

test("restore refuses an occupied identity and remove leaves foreign content untouched", async () => {
  const signal = new AbortController().signal
  const current = await record()
  expect(
    await restore(
      scripted(json({}), json(rangeResponse([kv(current.key, "foreign", "2")]))),
      current,
      "1",
      signal
    )
  ).toBeFalse()
  await remove(
    scripted(json({}), json(rangeResponse([kv(current.key, "foreign", "2")]))),
    current,
    signal
  )
  await expect(
    remove(
      scripted(json({}), json(rangeResponse([kv(current.key, current.value, "1")]))),
      current,
      signal
    )
  ).rejects.toThrow("remains after remove")
})

test("restore and remove resolve ambiguous transaction responses by exact readback", async () => {
  const signal = new AbortController().signal
  const current = await record()
  expect(
    await restore(
      scripted(
        rejected("lost restore"),
        json(rangeResponse([kv(current.key, current.value, "1")]))
      ),
      current,
      "1",
      signal
    )
  ).toBeTrue()
  await expect(
    restore(scripted(rejected("lost restore"), json(rangeResponse([]))), current, "1", signal)
  ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_TRANSPORT" })

  await remove(scripted(rejected("lost remove"), json(rangeResponse([]))), current, signal)
  await expect(
    remove(
      scripted(rejected("lost remove"), json(rangeResponse([kv(current.key, current.value, "1")]))),
      current,
      signal
    )
  ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_TRANSPORT" })
})
