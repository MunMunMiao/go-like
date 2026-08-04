import {
  keys as metadataKeys,
  newMetadata,
  values as metadataValues,
  type Metadata
} from "@go-like/metadata"

import { newTransportProtocolError } from "./errors"

const WirePrefix = "v1."
const MaximumMetadataHeaderBytes = 16_384

/** Encodes one canonical Metadata snapshot into a portable ASCII header or null when empty. */
export function encodeMetadataHeader(metadata: Metadata): string | null {
  const keys = metadataKeys(metadata)
  if (keys.length === 0) return null
  const entries: [string, readonly string[]][] = []
  for (const key of keys) entries.push([key, metadataValues(metadata, key)])
  const serialized = JSON.stringify(entries)
  if (typeof serialized !== "string") throw new TypeError("metadata could not be serialized")
  const encoded = `${WirePrefix}${encodeURIComponent(serialized)}`
  if (encoded.length > MaximumMetadataHeaderBytes) {
    throw new RangeError("encoded metadata header exceeds 16384 bytes")
  }
  return encoded
}

/** Copies one parsed value array after validating its exact string-only shape. */
function parsedValues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("metadata wire values must be an array")
  const copied: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index]
    if (typeof item !== "string") throw new TypeError("metadata wire values must be strings")
    copied.push(item)
  }
  return Object.freeze(copied)
}

/** Decodes and validates one canonical non-empty Metadata header value. */
function decodePresentMetadataHeader(value: string): Metadata {
  if (
    value.length > MaximumMetadataHeaderBytes ||
    !value.startsWith(WirePrefix) ||
    value.length === WirePrefix.length
  ) {
    throw new TypeError("metadata wire header is invalid")
  }
  const parsed: unknown = JSON.parse(decodeURIComponent(value.slice(WirePrefix.length)))
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError("metadata wire entries must be a non-empty array")
  }
  const seen = new Set<string>()
  const entries: [string, readonly string[]][] = []
  for (let index = 0; index < parsed.length; index += 1) {
    const entry: unknown = parsed[index]
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("metadata wire entry is invalid")
    }
    const rawKey: unknown = entry[0]
    if (typeof rawKey !== "string") throw new TypeError("metadata wire key must be a string")
    const key = rawKey
    const normalized = key.toLowerCase()
    if (key !== normalized || seen.has(normalized)) {
      throw new TypeError("metadata wire keys must be unique and lower-case")
    }
    seen.add(normalized)
    entries.push([key, parsedValues(entry[1])])
  }
  const decoded = newMetadata(Object.fromEntries(entries))
  if (encodeMetadataHeader(decoded) !== value) {
    throw new TypeError("metadata wire header is not canonical")
  }
  return decoded
}

/** Decodes one canonical Metadata header, treating null as an empty snapshot. */
export function decodeMetadataHeader(value: string | null): Metadata {
  if (value === null) return newMetadata()
  if (typeof value !== "string") throw new TypeError("metadata header must be a string or null")
  try {
    return decodePresentMetadataHeader(value)
  } catch {
    throw newTransportProtocolError("invalid metadata wire")
  }
}
