import type { ServiceInstance } from "@go-like/registry"
import { expect, test } from "bun:test"

import {
  decodeAgentReadback,
  decodeHealthResponse,
  encodeRegistration,
  registrationIdentity,
  type EncodedRegistration
} from "../src/codec"

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: { region: "east", zone: "a" },
  endpoints: ["http://127.0.0.1:8080/", "http://127.0.0.1:8081/"]
}

/** Converts one Agent registration body to Consul's health Service carrier. */
function carrier(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    ID: body.ID,
    Service: body.Name,
    Address: body.Address,
    Port: body.Port,
    Tags: body.Tags,
    Meta: body.Meta
  }
}

/** Creates one detached valid managed carrier and its exact wire record. */
async function managed(): Promise<{
  readonly encoded: EncodedRegistration
  readonly service: Record<string, unknown>
}> {
  const encoded = await encodeRegistration(instance, 2_000, 60_000)
  const body: unknown = JSON.parse(encoded.body)
  return {
    encoded,
    service: structuredClone(carrier(body as Readonly<Record<string, unknown>>))
  }
}

/** Returns the mutable metadata carrier owned by one detached test record. */
function metadata(service: Record<string, unknown>): Record<string, string> {
  const value = service.Meta
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("managed test carrier omitted Meta")
  }
  return value as Record<string, string>
}

/** Encodes bytes as canonical unpadded base64url for adversarial wire fixtures. */
function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** Deflates exact bytes through the same standard Web stream boundary as production. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(Array.from(bytes))])
    .stream()
    .pipeThrough(new CompressionStream("deflate"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Replaces the encoded payload chunks without changing unrelated managed metadata. */
function replaceChunks(service: Record<string, unknown>, encoded: string): void {
  const meta = metadata(service)
  for (const key of Object.keys(meta)) {
    if (key.startsWith("Go-Like-Chunk-") && key !== "Go-Like-Chunk-Count") delete meta[key]
  }
  const chunks: string[] = []
  for (let index = 0; index < encoded.length; index += 480) {
    chunks.push(encoded.slice(index, index + 480))
  }
  meta["Go-Like-Chunk-Count"] = String(chunks.length)
  for (let index = 0; index < chunks.length; index += 1) {
    meta[`Go-Like-Chunk-${String(index).padStart(3, "0")}`] = chunks[index] ?? ""
  }
}

/** Replaces the compressed managed payload with exact decoded bytes. */
async function replacePayload(service: Record<string, unknown>, bytes: Uint8Array): Promise<void> {
  replaceChunks(service, base64url(await deflate(bytes)))
}

/** Requires one managed carrier to fail at the provider protocol boundary. */
async function rejectsManaged(service: Record<string, unknown>, message: string): Promise<void> {
  await expect(
    decodeHealthResponse(JSON.stringify([{ Service: service }]), "orders")
  ).rejects.toThrow(message)
}

test("codec round-trips exactly one public ServiceInstance", async () => {
  const encoded = await encodeRegistration(instance, 2_000, 60_000)
  const body: unknown = JSON.parse(encoded.body)
  const service = carrier(body as Readonly<Record<string, unknown>>)
  expect(body).toMatchObject({
    ID: expect.stringMatching(/^li-[a-z2-7]{52}$/),
    Name: "orders",
    Address: "127.0.0.1",
    Port: 8080,
    Tags: ["Go-Like-Service-Instance=1"]
  })
  expect(encoded.remoteId).toBe(await registrationIdentity(instance))
  const decoded = await decodeHealthResponse(JSON.stringify([{ Service: service }]), "orders")
  expect(decoded).toHaveLength(1)
  expect(decoded[0]?.instance).toEqual(instance)
  expect(Object.isFrozen(decoded[0]?.instance)).toBe(true)
  expect(await decodeAgentReadback(JSON.stringify(service), encoded)).toBe(true)
})

test("codec projects canonical hostname, IPv4, IPv6, and HTTPS URLs", async () => {
  const endpoints = [
    ["http://service.internal:8080/", "service.internal", 8080],
    ["http://192.0.2.10:8081/", "192.0.2.10", 8081],
    ["http://[2001:db8::1]:8082/", "2001:db8::1", 8082],
    ["https://service.example/path", "service.example", 443]
  ] as const
  for (const [endpoint, host, port] of endpoints) {
    const encoded = await encodeRegistration({ ...instance, endpoints: [endpoint] }, 2_000, 60_000)
    const body: unknown = JSON.parse(encoded.body)
    expect(body).toMatchObject({ Address: host, Port: port })
  }
})

test("codec ignores foreign records and rejects corrupt managed records", async () => {
  expect(
    await decodeHealthResponse(
      JSON.stringify([
        {
          Service: {
            ID: "foreign",
            Service: "orders",
            Tags: ["foreign"],
            Meta: {}
          }
        }
      ]),
      "orders"
    )
  ).toEqual([])
  const encoded = await encodeRegistration(instance, 2_000, 60_000)
  const body: unknown = JSON.parse(encoded.body)
  const service = carrier(body as Readonly<Record<string, unknown>>)
  const corrupt = structuredClone(service)
  const meta = corrupt.Meta as Record<string, string>
  meta["Go-Like-Content-Hash"] = `lc-${"a".repeat(52)}`
  await expect(
    decodeHealthResponse(JSON.stringify([{ Service: corrupt }]), "orders")
  ).rejects.toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("codec validates endpoint and payload boundaries before Consul I/O", async () => {
  await expect(encodeRegistration({ ...instance, endpoints: [] }, 2_000, 60_000)).rejects.toThrow(
    "at least one"
  )
  await expect(
    encodeRegistration({ ...instance, endpoints: ["opaque"] }, 2_000, 60_000)
  ).rejects.toThrow("absolute URL")
  await expect(
    encodeRegistration({ ...instance, endpoints: ["tcp://service.internal"] }, 2_000, 60_000)
  ).rejects.toThrow("host and TCP port")
})

test("codec rejects every malformed managed metadata field before publication", async () => {
  const cases: readonly [
    string,
    (service: Record<string, unknown>, meta: Record<string, string>) => void,
    string
  ][] = [
    ["missing field", (_service, meta) => delete meta["Go-Like-Wire-Version"], "is missing"],
    ["invalid carrier", (service) => (service.ID = 1), "carrier is invalid"],
    ["wire version", (_service, meta) => (meta["Go-Like-Wire-Version"] = "2"), "unsupported"],
    ["encoding", (_service, meta) => (meta["Go-Like-Encoding"] = "gzip"), "unsupported"],
    ["hashes", (_service, meta) => (meta["Go-Like-Identity-Hash"] = "bad"), "hashes are invalid"],
    ["remote ID", (service) => (service.ID = "wrong"), "remote ID"],
    ["chunk count", (_service, meta) => (meta["Go-Like-Chunk-Count"] = "zero"), "count is invalid"],
    ["chunk ceiling", (_service, meta) => (meta["Go-Like-Chunk-Count"] = "33"), "provider bounds"],
    ["chunk size", (_service, meta) => (meta["Go-Like-Chunk-000"] = "a".repeat(481)), "exceeds 480"],
    ["chunk sequence", (_service, meta) => (meta["Go-Like-Chunk-999"] = "extra"), "unexpected key"]
  ]
  for (const [, mutate, message] of cases) {
    const value = await managed()
    mutate(value.service, metadata(value.service))
    await rejectsManaged(value.service, message)
  }
})

test("codec rejects malformed compression, text, and canonical payloads", async () => {
  const invalidBase64 = await managed()
  replaceChunks(invalidBase64.service, "=")
  await rejectsManaged(invalidBase64.service, "base64url is invalid")

  const nonCanonical = await managed()
  replaceChunks(nonCanonical.service, "AB")
  await rejectsManaged(nonCanonical.service, "not canonical")

  const invalidDeflate = await managed()
  replaceChunks(invalidDeflate.service, "AA")
  await rejectsManaged(invalidDeflate.service, "deflate stream is invalid")

  const invalidUtf8 = await managed()
  await replacePayload(invalidUtf8.service, new Uint8Array([255]))
  await rejectsManaged(invalidUtf8.service, "UTF-8 is invalid")

  const invalidTuple = await managed()
  await replacePayload(invalidTuple.service, new TextEncoder().encode('["wrong"]'))
  await rejectsManaged(invalidTuple.service, "tuple is invalid")

  const invalidInstance = await managed()
  await replacePayload(
    invalidInstance.service,
    new TextEncoder().encode(
      JSON.stringify([
        "go-like.registry-instance.v1",
        { id: "orders-1", name: "orders", version: "v1", metadata: {}, endpoints: ["opaque"] }
      ])
    )
  )
  await rejectsManaged(invalidInstance.service, "ServiceInstance is invalid")

  await expect(decodeHealthResponse("{", "orders")).rejects.toThrow("JSON is invalid")
  await expect(decodeHealthResponse("{}", "orders")).rejects.toThrow("must be an array")
})

test("codec enforces decoded and encoded payload ceilings", async () => {
  await expect(
    encodeRegistration({ ...instance, metadata: { payload: "x".repeat(1_048_576) } }, 2_000, 60_000)
  ).rejects.toThrow("decoded ServiceInstance payload exceeds")

  let seed = 0x12345678
  let noise = ""
  for (let index = 0; index < 40_000; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    noise += String.fromCharCode(33 + (seed % 94))
  }
  await expect(
    encodeRegistration({ ...instance, metadata: { payload: noise } }, 2_000, 60_000)
  ).rejects.toThrow("encoded ServiceInstance payload exceeds")

  const expanded = await managed()
  await replacePayload(expanded.service, new Uint8Array(1_048_577))
  await rejectsManaged(expanded.service, "decoded payload exceeds")
})
