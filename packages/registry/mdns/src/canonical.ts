import { type ServiceInstance } from "@likego/registry"
import { snapshotServiceInstance } from "@likego/registry/provider"

import { base32 } from "./base32"

/** Compares strings by Unicode code point without locale-dependent collation. */
function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = Number(left.codePointAt(leftIndex))
    const rightPoint = Number(right.codePointAt(rightIndex))
    if (leftPoint < rightPoint) return -1
    if (leftPoint > rightPoint) return 1
    leftIndex += leftPoint > 0xffff ? 2 : 1
    rightIndex += rightPoint > 0xffff ? 2 : 1
  }
  return leftIndex < left.length ? 1 : rightIndex < right.length ? -1 : 0
}

/** Converts metadata to canonical Unicode code-point sorted pairs. */
function metadataPairs(
  value: Readonly<Record<string, string>>
): readonly (readonly [string, string])[] {
  const entries = Object.entries(value)
  entries.sort(
    /** Orders one metadata entry by its exact key. */
    function compareEntry(left, right): number {
      return compareCodePoints(left[0], right[0])
    }
  )
  return entries
}

/** Hashes one exact UTF-8 preimage with Web Crypto SHA-256. */
async function hash(prefix: string, preimage: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage))
  return `${prefix}${base32(new Uint8Array(digest))}`
}

/** Returns the stable logical identity preimage for one service instance. */
export function identityPreimage(instance: ServiceInstance): string {
  const selected = snapshotServiceInstance(instance)
  return JSON.stringify([selected.name, selected.id])
}

/** Serializes one complete ServiceInstance payload as canonical UTF-8 JSON. */
export function canonicalPayload(instance: ServiceInstance): string {
  const selected = snapshotServiceInstance(instance)
  return [
    '{"id":',
    JSON.stringify(selected.id),
    ',"name":',
    JSON.stringify(selected.name),
    ',"version":',
    JSON.stringify(selected.version),
    ',"metadata":',
    JSON.stringify(metadataPairs(selected.metadata)),
    ',"endpoints":',
    JSON.stringify(selected.endpoints),
    "}"
  ].join("")
}

/** Computes the DNS-safe service label for one original service name. */
export async function serviceLabel(name: string): Promise<string> {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("mDNS service name must be non-empty")
  }
  return hash("ls-", name)
}

/** Computes the DNS-safe identity label for one ServiceInstance. */
export function identityLabel(instance: ServiceInstance): Promise<string> {
  return hash("li-", identityPreimage(instance))
}

/** Computes the DNS-safe identity-scoped host label for one ServiceInstance. */
export function hostLabel(instance: ServiceInstance): Promise<string> {
  const selected = snapshotServiceInstance(instance)
  return hash(
    "lh-",
    JSON.stringify(["likego.host.v2", identityPreimage(selected), selected.endpoints])
  )
}

/** Computes one stable content hash for the complete ServiceInstance payload. */
export function instanceContentHash(instance: ServiceInstance): Promise<string> {
  return hash("lc-", canonicalPayload(instance))
}
