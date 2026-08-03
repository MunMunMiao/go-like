import { type ServiceInstance } from "@likego/registry"
import { newRegistryProtocolError, snapshotServiceInstance } from "@likego/registry/provider"

import { canonicalPayload, instanceContentHash } from "./canonical"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const chunkPrefix = "Likego-Chunk-000="
const maximumChunkBytes = 255 - chunkPrefix.length

interface PayloadCandidate {
  readonly id?: unknown
  readonly name?: unknown
  readonly version?: unknown
  readonly metadata?: unknown
  readonly endpoints?: unknown
}

/** Reports whether a value is a non-array object suitable for payload inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Encodes arbitrary bytes as URL-safe no-padding Base64. */
function base64url(bytes: Uint8Array): string {
  let output = ""
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const chunk = bytes.slice(index, index + 3)
    let bits = 0
    for (const byte of chunk) bits = (bits << 8) | byte
    bits <<= (3 - chunk.byteLength) * 8
    output += base64Alphabet.charAt((bits >>> 18) & 63)
    output += base64Alphabet.charAt((bits >>> 12) & 63)
    if (index + 1 < bytes.byteLength) output += base64Alphabet.charAt((bits >>> 6) & 63)
    if (index + 2 < bytes.byteLength) output += base64Alphabet.charAt(bits & 63)
  }
  return output
}

/** Decodes URL-safe no-padding Base64 while rejecting non-canonical text. */
function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError("mDNS payload is not canonical base64url")
  }
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 4) {
    const count = Math.min(4, value.length - index)
    let bits = 0
    for (let inner = 0; inner < 4; inner += 1) {
      if (inner >= count) bits <<= 6
      else bits = (bits << 6) | base64Alphabet.indexOf(value.charAt(index + inner))
    }
    bytes.push((bits >>> 16) & 255)
    if (count >= 3) bytes.push((bits >>> 8) & 255)
    if (count === 4) bytes.push(bits & 255)
  }
  const decoded = new Uint8Array(bytes)
  if (base64url(decoded) !== value) throw new TypeError("mDNS payload is not canonical base64url")
  return decoded
}

/** Writes one complete byte sequence into a compression transform. */
async function writeTransform(
  writable: WritableStream<BufferSource>,
  bytes: Uint8Array<ArrayBuffer>
): Promise<void> {
  const writer = writable.getWriter()
  try {
    await writer.write(bytes)
    await writer.close()
  } catch (error) {
    await Promise.allSettled([writer.abort(error)])
    throw error
  }
}

/** Collects transform output while enforcing a hard pre-allocation ceiling. */
async function collectTransform(
  readable: ReadableStream<Uint8Array>,
  maximumBytes: number
): Promise<Uint8Array> {
  const reader = readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel("mDNS decoded payload overflow")
        throw new RangeError("mDNS decoded payload exceeds configured ceiling")
      }
      chunks.push(result.value.slice())
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/** Compresses canonical payload bytes with the standard deflate transform. */
async function compress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate")
  const writing = writeTransform(stream.writable, bytes)
  const output = await collectTransform(stream.readable, 65_536)
  await writing
  return output
}

/** Decompresses payload bytes while enforcing the decoded ceiling during streaming. */
async function decompress(
  bytes: Uint8Array<ArrayBuffer>,
  maximumBytes: number
): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate")
  const writing = writeTransform(stream.writable, bytes)
  try {
    const output = await collectTransform(stream.readable, maximumBytes)
    await writing
    return output
  } catch (error) {
    await writing.catch(
      /** Observes the paired transform-writer failure after a read failure. */
      function observeWriteFailure(): void {}
    )
    throw error
  }
}

/** Creates one encoded TXT item under the DNS 255-byte character-string limit. */
function txt(key: string, value: string): Uint8Array {
  return encoder.encode(`${key}=${value}`)
}

/** Converts canonical metadata pairs into one immutable string record. */
function metadata(value: unknown): Readonly<Record<string, string>> {
  if (!Array.isArray(value)) throw new TypeError("mDNS metadata must be an array of pairs")
  const entries: [string, string][] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length !== 2) {
      throw new TypeError("mDNS metadata pair is invalid")
    }
    const key = candidate[0]
    const item = candidate[1]
    if (typeof key !== "string" || typeof item !== "string" || seen.has(key)) {
      throw new TypeError("mDNS metadata pair is invalid or duplicate")
    }
    seen.add(key)
    entries.push([key, item])
  }
  return Object.freeze(Object.fromEntries(entries))
}

/** Parses one canonical payload object into a validated ServiceInstance. */
function parsePayload(value: unknown): ServiceInstance {
  if (!isRecord(value)) throw new TypeError("mDNS payload must be an object")
  const candidate: PayloadCandidate = value
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.version !== "string" ||
    !Array.isArray(candidate.endpoints)
  ) {
    throw new TypeError("mDNS payload identity or endpoints are invalid")
  }
  const endpoints: string[] = []
  for (const endpoint of candidate.endpoints) {
    if (typeof endpoint !== "string") throw new TypeError("mDNS payload endpoint is invalid")
    endpoints.push(endpoint)
  }
  return snapshotServiceInstance({
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    metadata: metadata(candidate.metadata),
    endpoints
  })
}

/** Reads unique UTF-8 key/value TXT items into an exact map. */
function txtMap(items: readonly Uint8Array[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (const item of items) {
    const text = decoder.decode(item)
    const separator = text.indexOf("=")
    if (separator < 1) throw new TypeError("mDNS TXT item must contain a key and value")
    const key = text.slice(0, separator)
    if (values.has(key)) throw new TypeError(`mDNS TXT key ${key} is duplicated`)
    values.set(key, text.slice(separator + 1))
  }
  return values
}

/** Returns one required TXT value or rejects a missing field. */
function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined) throw new TypeError(`mDNS TXT key ${key} is missing`)
  return value
}

/** Wraps one untrusted TXT/decompression boundary failure as a stable protocol error. */
function protocol(value: unknown): Error {
  const cause =
    value instanceof Error ? value : new Error("mDNS TXT boundary rejected a non-Error value")
  return newRegistryProtocolError("invalid LikeGo mDNS TXT payload", cause)
}

/** Encodes one ServiceInstance into ordered LikeGo TXT items. */
export async function encodeInstanceTXT(
  instance: ServiceInstance,
  maximumDecodedBytes: number
): Promise<readonly Uint8Array[]> {
  const canonical = canonicalPayload(instance)
  const decoded = encoder.encode(canonical)
  if (decoded.byteLength > maximumDecodedBytes) {
    throw new RangeError("mDNS canonical payload exceeds configured decoded ceiling")
  }
  const compressed = await compress(decoded)
  const encoded = base64url(compressed)
  const count = Math.ceil(encoded.length / maximumChunkBytes)
  const items: Uint8Array[] = [
    txt("Likego-Wire-Version", "2"),
    txt("Likego-Encoding", "deflate+base64url"),
    txt("Likego-Instance-Content-Hash", await instanceContentHash(instance)),
    txt("Likego-Chunk-Count", String(count).padStart(3, "0"))
  ]
  for (let index = 0; index < count; index += 1) {
    items.push(
      txt(
        `Likego-Chunk-${String(index).padStart(3, "0")}`,
        encoded.slice(index * maximumChunkBytes, (index + 1) * maximumChunkBytes)
      )
    )
  }
  return Object.freeze(items)
}

/** Decodes ordered LikeGo TXT items into one validated ServiceInstance. */
export async function decodeInstanceTXT(
  items: readonly Uint8Array[],
  maximumDecodedBytes: number
): Promise<ServiceInstance> {
  try {
    const values = txtMap(items)
    if (required(values, "Likego-Wire-Version") !== "2") {
      throw new TypeError("mDNS wire version is unsupported")
    }
    if (required(values, "Likego-Encoding") !== "deflate+base64url") {
      throw new TypeError("mDNS payload encoding is unsupported")
    }
    const countText = required(values, "Likego-Chunk-Count")
    if (!/^[0-9]{3}$/.test(countText)) throw new TypeError("mDNS chunk count is invalid")
    const count = Number(countText)
    if (count < 1 || count > 999) throw new RangeError("mDNS chunk count is out of range")
    if (values.size !== count + 4) {
      throw new TypeError("mDNS TXT schema contains missing or unknown fields")
    }
    let encoded = ""
    for (let index = 0; index < count; index += 1) {
      encoded += required(values, `Likego-Chunk-${String(index).padStart(3, "0")}`)
    }
    const decoded = await decompress(unbase64url(encoded), maximumDecodedBytes)
    const json = decoder.decode(decoded)
    const instance = parsePayload(JSON.parse(json))
    if (canonicalPayload(instance) !== json)
      throw new TypeError("mDNS payload is not canonical JSON")
    if (
      (await instanceContentHash(instance)) !== required(values, "Likego-Instance-Content-Hash")
    ) {
      throw new TypeError("mDNS instance-content hash mismatch")
    }
    return instance
  } catch (error) {
    throw protocol(error)
  }
}
