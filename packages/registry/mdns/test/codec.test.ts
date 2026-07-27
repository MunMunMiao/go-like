import { describe, expect, test } from "bun:test"

import type { ServiceInstance } from "@likego/registry"

import { base32 } from "../src/base32"
import {
  canonicalPayload,
  hostLabel,
  identityLabel,
  instanceContentHash,
  serviceLabel
} from "../src/canonical"
import { decodeInstanceTXT, encodeInstanceTXT } from "../src/codec"

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Creates one deterministic wire fixture. */
function fixture(): ServiceInstance {
  return {
    id: "node-1",
    name: "catalog",
    version: "v1",
    metadata: { z: "last", a: "first" },
    endpoints: ["http://127.0.0.1:8080/", "https://[::1]:8080/"]
  }
}

/** Replaces or appends one TXT key while retaining byte ownership. */
function replace(items: readonly Uint8Array[], key: string, value: string): readonly Uint8Array[] {
  const encoder = new TextEncoder()
  const output: Uint8Array[] = []
  let found = false
  for (const item of items) {
    const text = decoder.decode(item)
    if (text.startsWith(`${key}=`)) {
      output.push(encoder.encode(`${key}=${value}`))
      found = true
    } else {
      output.push(item.slice())
    }
  }
  if (!found) output.push(encoder.encode(`${key}=${value}`))
  return output
}

/** Removes every TXT item for one key. */
function remove(items: readonly Uint8Array[], key: string): readonly Uint8Array[] {
  return items
    .filter((item) => !decoder.decode(item).startsWith(`${key}=`))
    .map((item) => item.slice())
}

/** Encodes bytes as URL-safe no-padding Base64 for malformed payload fixtures. */
function base64url(bytes: Uint8Array): string {
  let output = ""
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const bits = (first << 16) | (second << 8) | third
    output += base64Alphabet[(bits >>> 18) & 63] ?? ""
    output += base64Alphabet[(bits >>> 12) & 63] ?? ""
    if (index + 1 < bytes.byteLength) output += base64Alphabet[(bits >>> 6) & 63] ?? ""
    if (index + 2 < bytes.byteLength) output += base64Alphabet[bits & 63] ?? ""
  }
  return output
}

/** Builds valid v2 TXT framing around arbitrary deflated JSON. */
async function rawItems(json: string): Promise<readonly Uint8Array[]> {
  const stream = new CompressionStream("deflate")
  const reading = new Response(stream.readable).arrayBuffer()
  const writer = stream.writable.getWriter()
  await writer.write(encoder.encode(json))
  await writer.close()
  const encoded = base64url(new Uint8Array(await reading))
  const chunkSize = 255 - "Likego-Chunk-000=".length
  const count = Math.ceil(encoded.length / chunkSize)
  const items: Uint8Array[] = [
    encoder.encode("Likego-Wire-Version=2"),
    encoder.encode("Likego-Encoding=deflate+base64url"),
    encoder.encode("Likego-Instance-Content-Hash=unused"),
    encoder.encode(`Likego-Chunk-Count=${String(count).padStart(3, "0")}`)
  ]
  for (let index = 0; index < count; index += 1) {
    items.push(
      encoder.encode(
        `Likego-Chunk-${String(index).padStart(3, "0")}=${encoded.slice(index * chunkSize, (index + 1) * chunkSize)}`
      )
    )
  }
  return items
}

describe("canonical mDNS ServiceInstance codec", () => {
  test("uses deterministic DNS labels and identity independent of mutable version", async () => {
    const current = fixture()
    const updated = { ...current, version: "v2" }
    expect(base32(new TextEncoder().encode("foo"))).toBe("mzxw6")
    expect(await serviceLabel(current.name)).toMatch(/^ls-[a-z2-7]{52}$/)
    expect(await identityLabel(current)).toBe(await identityLabel(updated))
    expect(await hostLabel(current)).toMatch(/^lh-[a-z2-7]{52}$/)
    expect(await instanceContentHash(current)).not.toBe(await instanceContentHash(updated))
    await expect(serviceLabel("")).rejects.toThrow(TypeError)
  })

  test("serializes canonical JSON with metadata keys in Unicode code-point order", () => {
    expect(canonicalPayload(fixture())).toBe(
      '{"id":"node-1","name":"catalog","version":"v1","metadata":[["a","first"],["z","last"]],"endpoints":["http://127.0.0.1:8080/","https://[::1]:8080/"]}'
    )
    expect(
      canonicalPayload({
        ...fixture(),
        metadata: { "a😀": "long", a: "short", "😀": "astral" }
      })
    ).toContain('"metadata":[["a","short"],["a😀","long"],["😀","astral"]]')
  })

  test("compresses, chunks, hashes, and round-trips one immutable instance", async () => {
    const current = fixture()
    const items = await encodeInstanceTXT(current, 65_536)
    const texts = items.map((item) => decoder.decode(item))
    expect(texts.slice(0, 4).map((text) => text.split("=", 1)[0])).toEqual([
      "Likego-Wire-Version",
      "Likego-Encoding",
      "Likego-Instance-Content-Hash",
      "Likego-Chunk-Count"
    ])
    expect(texts[0]).toBe("Likego-Wire-Version=2")
    expect(texts[1]).toBe("Likego-Encoding=deflate+base64url")
    expect(items.every((item) => item.byteLength <= 255)).toBe(true)
    const decoded = await decodeInstanceTXT(items, 65_536)
    expect(decoded).toEqual(current)
    expect(Object.isFrozen(decoded)).toBe(true)
  })

  test("rejects malformed schema, encoding, chunk, hash, and decoded ceilings", async () => {
    const items = await encodeInstanceTXT(fixture(), 65_536)
    await expect(decodeInstanceTXT(remove(items, "Likego-Encoding"), 65_536)).rejects.toMatchObject(
      { code: "LIKEGO_REGISTRY_PROTOCOL" }
    )
    await expect(
      decodeInstanceTXT(replace(items, "Likego-Wire-Version", "1"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    await expect(
      decodeInstanceTXT(replace(items, "Likego-Encoding", "gzip"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    await expect(
      decodeInstanceTXT(replace(items, "Likego-Chunk-Count", "abc"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    await expect(
      decodeInstanceTXT(replace(items, "Likego-Instance-Content-Hash", "wrong"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    await expect(
      decodeInstanceTXT(replace(items, "Likego-Unknown", "value"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    await expect(
      decodeInstanceTXT(replace(items, "Likego-Chunk-000", "%"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    await expect(decodeInstanceTXT(items, 16)).rejects.toMatchObject({
      code: "LIKEGO_REGISTRY_PROTOCOL"
    })
    await expect(encodeInstanceTXT(fixture(), 8)).rejects.toThrow(RangeError)
  })

  test("rejects duplicate and non-contiguous chunk keys", async () => {
    const items = await encodeInstanceTXT(fixture(), 65_536)
    const duplicate = items.map((item) => item.slice())
    const firstChunk = items[4]
    if (firstChunk === undefined) throw new Error("fixture chunk is missing")
    duplicate.push(firstChunk.slice())
    await expect(decodeInstanceTXT(duplicate, 65_536)).rejects.toMatchObject({
      code: "LIKEGO_REGISTRY_PROTOCOL"
    })
    await expect(
      decodeInstanceTXT(remove(items, "Likego-Chunk-000"), 65_536)
    ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
  })

  test("rejects malformed decoded metadata and identity shapes", async () => {
    for (const json of [
      '{"id":"n","name":"s","version":"v","metadata":[["a"]],"endpoints":["http://127.0.0.1/"]}',
      '{"id":"n","name":"s","version":"v","metadata":[["a","1"],["a","2"]],"endpoints":["http://127.0.0.1/"]}',
      '{"name":"s","version":"v","metadata":[],"endpoints":["http://127.0.0.1/"]}'
    ]) {
      await expect(decodeInstanceTXT(await rawItems(json), 65_536)).rejects.toMatchObject({
        code: "LIKEGO_REGISTRY_PROTOCOL"
      })
    }
  })
})
