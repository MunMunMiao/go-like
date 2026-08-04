import { type ServiceInstance } from "@go-like/registry"
import { newRegistryProtocolError, snapshotServiceInstance } from "@go-like/registry/provider"

import { ignoreFailure } from "./runtime"

const marker = "Go-Like-Service-Instance=1"
const chunkPrefix = "Go-Like-Chunk-"
const chunkBytes = 480
const maximumChunks = 32
const maximumEncodedBytes = chunkBytes * maximumChunks
const maximumDecodedBytes = 1_048_576
const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567"
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Captures one deterministic Consul Agent registration payload. */
export interface EncodedRegistration {
  readonly identity: string
  readonly content: string
  readonly remoteId: string
  readonly instance: ServiceInstance
  readonly body: string
}

/** Captures one fully verified managed Consul health record. */
export interface DecodedRegistration {
  readonly identity: string
  readonly content: string
  readonly remoteId: string
  readonly instance: ServiceInstance
}

interface HostPort {
  readonly host: string
  readonly port: number
}

/** Reads one own data property without invoking accessors or inherited properties. */
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one JSON value to a non-array object. */
function record(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parses untrusted JSON without reflecting response bytes through native parser diagnostics. */
function parse(text: string, name: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw newRegistryProtocolError(`Consul ${name} JSON is invalid`)
  }
}

/** Encodes bytes as lowercase RFC 4648 Base32 without padding. */
function base32(bytes: Uint8Array): string {
  let output = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += base32Alphabet.charAt((buffer >>> bits) & 31)
    }
  }
  if (bits > 0) output += base32Alphabet.charAt((buffer << (5 - bits)) & 31)
  return output
}

/** Encodes arbitrary bytes as canonical unpadded base64url. */
function base64url(bytes: Uint8Array): string {
  let output = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      output += base64UrlAlphabet.charAt((buffer >>> bits) & 63)
    }
  }
  if (bits > 0) output += base64UrlAlphabet.charAt((buffer << (6 - bits)) & 63)
  return output
}

/** Decodes strict unpadded base64url and rejects non-canonical encodings. */
function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw newRegistryProtocolError("Consul payload base64url is invalid")
  }
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of value) {
    const digit = base64UrlAlphabet.indexOf(character)
    buffer = (buffer << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 255)
    }
  }
  const decoded = new Uint8Array(bytes)
  if (base64url(decoded) !== value) {
    throw newRegistryProtocolError("Consul payload base64url is not canonical")
  }
  return decoded
}

/** Computes one stable SHA-256 Base32 identifier. */
async function hash(prefix: string, bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(Array.from(bytes)).buffer)
  return `${prefix}-${base32(new Uint8Array(digest))}`
}

/** Computes the provider wire identity from public name and instance ID only. */
function instanceIdentity(instance: ServiceInstance): Promise<string> {
  return hash(
    "li",
    new TextEncoder().encode(
      JSON.stringify(["go-like.registry-instance.identity.v1", instance.name, instance.id])
    )
  )
}

/** Returns the deterministic Consul service ID for one public ServiceInstance identity. */
export function registrationIdentity(value: ServiceInstance): Promise<string> {
  return instanceIdentity(snapshotServiceInstance(value))
}

/** Runs one standard CompressionStream transform and collects its complete bytes. */
async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate")
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const writing = writer.write(new Uint8Array(bytes)).then(
    /** Closes the transform input after its complete source chunk is consumed. */
    function closeWriter(): Promise<void> {
      return writer.close()
    }
  )
  const output: number[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    for (const byte of result.value) output.push(byte)
  }
  await writing
  return new Uint8Array(output)
}

/** Inflates a payload while enforcing the decoded hard ceiling before JSON parsing. */
async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  const output: number[] = []
  let writer: WritableStreamDefaultWriter<BufferSource> | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    const stream = new DecompressionStream("deflate")
    const activeWriter = stream.writable.getWriter()
    writer = activeWriter
    reader = stream.readable.getReader()
    const writing = activeWriter.write(new Uint8Array(bytes)).then(
      /** Closes the transform input after its complete compressed chunk is consumed. */
      function closeWriter(): Promise<void> {
        return activeWriter.close()
      }
    )
    void writing.catch(ignoreFailure)
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (output.length + result.value.length > maximumDecodedBytes) {
        throw newRegistryProtocolError("Consul decoded payload exceeds the provider ceiling")
      }
      for (const byte of result.value) output.push(byte)
    }
    await writing
  } catch (value) {
    void writer?.abort().catch(ignoreFailure)
    void reader?.cancel().catch(ignoreFailure)
    if (value instanceof Error && "code" in value && value.code === "GO_LIKE_REGISTRY_PROTOCOL") {
      throw value
    }
    throw newRegistryProtocolError("Consul payload deflate stream is invalid")
  }
  return new Uint8Array(output)
}

/** Projects one public endpoint to the Consul Agent address and port fields. */
function hostPort(value: string): HostPort {
  const url = new URL(value)
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
  const defaultPort = url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : 0
  const port = url.port === "" ? defaultPort : Number(url.port)
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Consul URL endpoint requires a host and TCP port")
  }
  return Object.freeze({ host, port })
}

/** Serializes one validated ServiceInstance into stable UTF-8 JSON bytes. */
function canonicalPayload(instance: ServiceInstance): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(["go-like.registry-instance.v1", instance]))
}

/** Narrows one parsed carrier enough for the public snapshot validator. */
function instanceCarrier(value: unknown): value is ServiceInstance {
  return (
    record(value) &&
    typeof own(value, "id") === "string" &&
    typeof own(value, "name") === "string" &&
    typeof own(value, "version") === "string" &&
    record(own(value, "metadata")) &&
    Array.isArray(own(value, "endpoints"))
  )
}

/** Deserializes one canonical payload tuple and re-snapshots its public instance. */
function instancePayload(bytes: Uint8Array): ServiceInstance {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw newRegistryProtocolError("Consul payload UTF-8 is invalid")
  }
  const value = parse(text, "payload")
  const instance = Array.isArray(value) ? value[1] : undefined
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== "go-like.registry-instance.v1" ||
    !instanceCarrier(instance)
  ) {
    throw newRegistryProtocolError("Consul payload tuple is invalid")
  }
  try {
    return snapshotServiceInstance(instance)
  } catch {
    throw newRegistryProtocolError("Consul payload ServiceInstance is invalid")
  }
}

/** Returns one zero-padded chunk metadata key. */
function chunkKey(index: number): string {
  return `${chunkPrefix}${String(index).padStart(3, "0")}`
}

/** Creates the complete Consul Agent body for one public ServiceInstance. */
export async function encodeRegistration(
  value: ServiceInstance,
  ttlMs: number,
  deregisterCriticalServiceAfterMs: number
): Promise<EncodedRegistration> {
  const instance = snapshotServiceInstance(value)
  const endpoint = instance.endpoints[0]
  if (endpoint === undefined) {
    throw new TypeError("Consul registration requires at least one ServiceInstance endpoint")
  }
  const primary = hostPort(endpoint)
  const payload = canonicalPayload(instance)
  if (payload.length > maximumDecodedBytes) {
    throw new RangeError("Consul decoded ServiceInstance payload exceeds 1048576 bytes")
  }
  const [identity, content, deflated] = await Promise.all([
    instanceIdentity(instance),
    hash("lc", payload),
    compress(payload)
  ])
  const encoded = base64url(deflated)
  if (encoded.length > maximumEncodedBytes) {
    throw new RangeError("Consul encoded ServiceInstance payload exceeds 15360 bytes")
  }
  const chunks: string[] = []
  for (let index = 0; index < encoded.length; index += chunkBytes) {
    chunks.push(encoded.slice(index, index + chunkBytes))
  }
  const entries: [string, string][] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (chunk !== undefined) entries.push([chunkKey(index), chunk])
  }
  entries.push(
    ["Go-Like-Chunk-Count", String(chunks.length)],
    ["Go-Like-Content-Hash", content],
    ["Go-Like-Encoding", "deflate+base64url"],
    ["Go-Like-Identity-Hash", identity],
    ["Go-Like-Wire-Version", "1"]
  )
  const body = JSON.stringify({
    ID: identity,
    Name: instance.name,
    Address: primary.host,
    Port: primary.port,
    Tags: [marker],
    Meta: Object.fromEntries(entries),
    Check: {
      CheckID: `service:${identity}`,
      Name: `go-like TTL for ${instance.name}/${instance.id}`,
      TTL: `${ttlMs}ms`,
      Status: "passing",
      DeregisterCriticalServiceAfter: `${deregisterCriticalServiceAfterMs}ms`
    }
  })
  return Object.freeze({
    identity,
    content,
    remoteId: identity,
    instance,
    body
  })
}

/** Reads one required string Meta field from a managed record. */
function metaString(meta: object, key: string): string {
  const value = own(meta, key)
  if (typeof value !== "string") {
    throw newRegistryProtocolError(`Consul managed Meta ${key} is missing`)
  }
  return value
}

/** Decodes and verifies one managed health Service carrier. */
async function decodeManagedService(value: object): Promise<DecodedRegistration | null> {
  const tagsValue = own(value, "Tags")
  if (!Array.isArray(tagsValue)) return null
  const tags: string[] = []
  for (const tag of tagsValue) if (typeof tag === "string") tags.push(tag)
  if (!tags.includes(marker)) return null
  const remoteId = own(value, "ID")
  const name = own(value, "Service")
  const meta = own(value, "Meta")
  if (typeof remoteId !== "string" || typeof name !== "string" || !record(meta)) {
    throw newRegistryProtocolError("Consul managed Service carrier is invalid")
  }
  if (metaString(meta, "Go-Like-Wire-Version") !== "1") {
    throw newRegistryProtocolError("Consul managed wire version is unsupported")
  }
  if (metaString(meta, "Go-Like-Encoding") !== "deflate+base64url") {
    throw newRegistryProtocolError("Consul managed encoding is unsupported")
  }
  const identity = metaString(meta, "Go-Like-Identity-Hash")
  const content = metaString(meta, "Go-Like-Content-Hash")
  if (!/^li-[a-z2-7]{52}$/.test(identity) || !/^lc-[a-z2-7]{52}$/.test(content)) {
    throw newRegistryProtocolError("Consul managed hashes are invalid")
  }
  if (remoteId !== identity) {
    throw newRegistryProtocolError("Consul managed remote ID does not match its identity")
  }
  const chunkCountText = metaString(meta, "Go-Like-Chunk-Count")
  if (!/^[1-9][0-9]*$/.test(chunkCountText)) {
    throw newRegistryProtocolError("Consul managed chunk count is invalid")
  }
  const chunkCount = Number(chunkCountText)
  if (chunkCount < 1 || chunkCount > maximumChunks) {
    throw newRegistryProtocolError("Consul managed chunk count exceeds provider bounds")
  }
  const chunks: string[] = []
  const expectedChunkKeys = new Set<string>()
  for (let index = 0; index < chunkCount; index += 1) {
    const key = chunkKey(index)
    expectedChunkKeys.add(key)
    const chunk = metaString(meta, key)
    if (chunk.length > chunkBytes) {
      throw newRegistryProtocolError("Consul managed chunk exceeds 480 bytes")
    }
    chunks.push(chunk)
  }
  for (const key of Object.keys(meta)) {
    if (
      key !== "Go-Like-Chunk-Count" &&
      key.startsWith(chunkPrefix) &&
      !expectedChunkKeys.has(key)
    ) {
      throw newRegistryProtocolError("Consul managed chunk sequence contains an unexpected key")
    }
  }
  const instance = instancePayload(await decompress(decodeBase64url(chunks.join(""))))
  const [actualIdentity, actualContent] = await Promise.all([
    instanceIdentity(instance),
    hash("lc", canonicalPayload(instance))
  ])
  if (
    identity !== actualIdentity ||
    content !== actualContent ||
    name !== instance.name ||
    remoteId !== actualIdentity
  ) {
    throw newRegistryProtocolError("Consul managed ServiceInstance verification failed")
  }
  return Object.freeze({ identity, content, remoteId, instance })
}

/** Decodes all passing managed instances while ignoring foreign services. */
export async function decodeHealthResponse(
  text: string,
  expectedName: string
): Promise<readonly DecodedRegistration[]> {
  const value = parse(text, "health response")
  if (!Array.isArray(value)) {
    throw newRegistryProtocolError("Consul health response must be an array")
  }
  const decoded: DecodedRegistration[] = []
  for (const entry of value) {
    if (!record(entry)) throw newRegistryProtocolError("Consul health entry must be an object")
    const carrier = own(entry, "Service")
    if (!record(carrier)) throw newRegistryProtocolError("Consul health entry requires Service")
    const managed = await decodeManagedService(carrier)
    if (managed !== null && managed.instance.name === expectedName) decoded.push(managed)
  }
  return Object.freeze(decoded)
}

/** Decodes one Agent service readback and verifies the expected exact record. */
export async function decodeAgentReadback(
  text: string,
  expected: EncodedRegistration
): Promise<boolean> {
  const value = parse(text, "Agent readback")
  if (!record(value)) throw newRegistryProtocolError("Consul Agent readback must be an object")
  const decoded = await decodeManagedService(value)
  return (
    decoded !== null &&
    decoded.remoteId === expected.remoteId &&
    decoded.content === expected.content
  )
}
