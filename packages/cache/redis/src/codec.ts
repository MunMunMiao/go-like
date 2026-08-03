import { newRedisCacheProtocolError } from "./errors"

const WirePrefix = "v1:"
const CanonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Encodes detached bytes into the versioned canonical Redis string carrier. */
export function encodeRedisCacheValue(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return `${WirePrefix}${btoa(binary)}`
}

/** Decodes one bounded canonical Redis carrier into detached bytes. */
export function decodeRedisCacheValue(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== "string" || !value.startsWith(WirePrefix)) {
    throw newRedisCacheProtocolError()
  }
  const encoded = value.slice(WirePrefix.length)
  if (!CanonicalBase64.test(encoded)) throw newRedisCacheProtocolError()
  const expectedBytes =
    Math.floor((encoded.length * 3) / 4) -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
  if (expectedBytes > maximumBytes) throw newRedisCacheProtocolError()
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (encodeRedisCacheValue(bytes) !== value) throw newRedisCacheProtocolError()
  return bytes
}
