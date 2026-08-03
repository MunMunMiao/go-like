import type { ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import {
  decodeBytes,
  decodeRecord,
  encodeRecord,
  prefixRangeEnd,
  recordPrefix,
  registrationIdentity,
  unbase64
} from "../src/codec"

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: { region: "east" },
  endpoints: ["http://127.0.0.1:8080/"]
}

test("canonical record binds deterministic identity, content, payload, and key", async () => {
  const record = await encodeRecord("/likego/registry/v1/", instance)
  expect(record.identity).toBe(await registrationIdentity(instance))
  expect(record.key).toBe(`${recordPrefix("/likego/registry/v1/")}${record.identity}`)
  expect(await decodeRecord("/likego/registry/v1/", record.key, record.value)).toEqual({
    identity: record.identity,
    content: record.content,
    instance: record.instance
  })
  await expect(
    decodeRecord("/likego/registry/v1/", `${record.key}-other`, record.value)
  ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
})

test("byte codec rejects malformed Base64 and invalid UTF-8", () => {
  expect(() => unbase64("!")).toThrow("invalid Base64")
  expect(() => unbase64("AB==")).toThrow("not canonical")
  expect(() => decodeBytes("!")).toThrow("invalid Base64")
  expect(() => decodeBytes("/w==")).toThrow("invalid UTF-8")
  expect(prefixRangeEnd("")).toBe("AA==")
})

test("record decoder rejects malformed and oversized managed values", async () => {
  const record = await encodeRecord("/likego/registry/v1/", instance)
  await expect(decodeRecord("/likego/registry/v1/", record.key, "not-json")).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
  await expect(decodeRecord("/likego/registry/v1/", record.key, "[]")).rejects.toThrow(
    "unsupported wire shape"
  )
  const fields: unknown[] = JSON.parse(record.value)
  fields[1] = 1
  await expect(
    decodeRecord("/likego/registry/v1/", record.key, JSON.stringify(fields))
  ).rejects.toThrow("fields are invalid")
  const invalid: unknown[] = JSON.parse(record.value)
  const carrier = invalid[3] as Record<string, unknown>
  carrier.name = ""
  await expect(
    decodeRecord("/likego/registry/v1/", record.key, JSON.stringify(invalid))
  ).rejects.toThrow("invalid ServiceInstance")
  await expect(
    decodeRecord("/likego/registry/v1/", record.key, "x".repeat(1_048_577))
  ).rejects.toThrow("payload ceiling")
  const oversized = { ...instance, metadata: { value: "x".repeat(1_048_576) } }
  await expect(encodeRecord("/likego/registry/v1/", oversized)).rejects.toThrow("payload exceeds")
})
