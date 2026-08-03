import { expect, test } from "bun:test"

import {
  decodePathSegment,
  decodeRecord,
  encodePathSegment,
  encodeRecord,
  instanceIdentity,
  instancePath,
  servicePath,
  servicesPath
} from "../src/codec"
import { newOperationError } from "../src/errors"
import { captureOptions, operationOptions } from "../src/options"
import { instances } from "../src/records"
import { pruneServiceParent, readServiceRecords } from "../src/tree"
import { fakeZookeeper, fixture } from "./helpers"

/** Encodes one arbitrary JSON carrier. */
function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

test("path segments preserve Unicode, slash, and empty instance IDs", () => {
  for (const value of ["", "a", "目录/服务", "東京-猫", "😀"]) {
    const encoded = encodePathSegment(value)
    expect(encoded).toMatch(/^u-[A-Za-z0-9_-]*$/)
    expect(decodePathSegment(encoded)).toBe(value)
  }
  expect(servicesPath("/root")).toBe("/root/services")
  expect(servicePath("/root", "a/b")).toBe(`/root/services/${encodePathSegment("a/b")}`)
  expect(instancePath("/root", "a/b", "")).toEndWith("/u-")
  expect(() => decodePathSegment("bad")).toThrow("segment is invalid")
  expect(() => decodePathSegment("u-A")).toThrow("Base64 length")
  expect(() => decodePathSegment("u-AB")).toThrow("not canonical")
  expect(() => decodePathSegment("u-_w")).toThrow("invalid UTF-8")
})

test("deterministic ServiceInstance records round-trip and fail closed", () => {
  const value = fixture("initial")
  const record = encodeRecord("/root", value)
  expect(record.path).toBe(instancePath("/root", value.name, value.id))
  expect(instanceIdentity(value)).toBe(JSON.stringify([value.name, value.id]))
  expect(decodeRecord("/root", record.path, record.data)).toMatchObject({
    path: record.path,
    identity: record.identity,
    instance: record.instance
  })
  expect(() => decodeRecord("/root", record.path, new Uint8Array(1_048_577))).toThrow(
    "payload ceiling"
  )
  expect(() => decodeRecord("/root", record.path, new Uint8Array([255]))).toThrow("invalid UTF-8")
  expect(() => decodeRecord("/root", record.path, bytes("{"))).toThrow("unsupported wire")
  expect(() => decodeRecord("/root", record.path, new TextEncoder().encode("{"))).toThrow(
    "not valid JSON"
  )
  expect(() => decodeRecord("/root", record.path, bytes(["wrong", value]))).toThrow(
    "unsupported wire"
  )
  expect(() =>
    decodeRecord("/root", record.path, bytes(["likego.registry-zookeeper.v2", null]))
  ).toThrow("invalid ServiceInstance")
  expect(() => decodeRecord("/other", record.path, record.data)).toThrow("path does not match")
  expect(() =>
    encodeRecord("/root", {
      ...value,
      metadata: { large: "x".repeat(1_048_576) }
    })
  ).toThrow("payload exceeds")
})

test("record snapshots reject duplicate identities and remain immutable", () => {
  const first = encodeRecord("/root", fixture("initial"))
  const updated = encodeRecord("/root", fixture("updated"))
  expect(instances([decodeRecord("/root", first.path, first.data)])).toEqual([first.instance])
  expect(() =>
    instances([
      decodeRecord("/root", first.path, first.data),
      decodeRecord("/root", updated.path, updated.data)
    ])
  ).toThrow("duplicate service identity")
  expect(instances([], "missing")).toEqual([])
})

test("tree reads and parent pruning preserve native failure semantics", async () => {
  const zookeeper = fakeZookeeper()
  const client = await zookeeper.putRaw("/bootstrap", new Uint8Array())
  const provider = captureOptions(
    { address: "fake:2181", clientFactory: zookeeper.factory },
    zookeeper.factory
  )
  const options = operationOptions(provider, provider.common)
  const signal = new AbortController().signal
  const denied = newOperationError("children", -102, false)
  await expect(
    readServiceRecords(client, options, "denied", signal, async function deniedChildren() {
      throw denied
    })
  ).rejects.toBe(denied)

  const record = encodeRecord(options.root, fixture("initial", "prune-errors"))
  zookeeper.failNext("remove", -111)
  await pruneServiceParent(client, record, signal)
  zookeeper.failNext("remove", -101)
  await pruneServiceParent(client, record, signal)
  const failure = newOperationError("remove", -102, false)
  zookeeper.failNext("remove", failure.nativeCode ?? -102)
  await expect(pruneServiceParent(client, record, signal)).rejects.toMatchObject({
    nativeCode: -102,
    operation: "remove"
  })
  await client.close(signal)
})
