import type { ServiceInstance } from "./types"

/** Compares two strings lexicographically by Unicode code point. */
export function compareCodePoints(left: string, right: string): number {
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
  if (leftIndex < left.length) return 1
  if (rightIndex < right.length) return -1
  return 0
}

/** Reports whether a string contains no unmatched UTF-16 surrogate code units. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Validates one service-instance string. */
function text(value: unknown, field: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError(`${field} must be a${nonEmpty ? " non-empty" : ""} string`)
  }
  return value
}

/** Canonicalizes one absolute endpoint URL without credentials or fragments. */
function endpoint(value: unknown): string {
  const source = text(value, "ServiceInstance endpoint")
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw new TypeError("ServiceInstance endpoint must be an absolute URL")
  }
  if (
    parsed.protocol.length === 0 ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0 ||
    parsed.href.includes("#")
  ) {
    throw new TypeError("ServiceInstance endpoint must omit credentials and fragments")
  }
  return parsed.toString()
}

/** Copies and freezes one metadata record in deterministic key order. */
function metadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("ServiceInstance.metadata must be a string record")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("ServiceInstance.metadata must be a plain string record")
  }
  const entries: [string, string][] = []
  for (const key of Object.keys(value)) {
    entries.push([
      text(key, "ServiceInstance.metadata key", false),
      text(Reflect.get(value, key), "ServiceInstance.metadata value", false)
    ])
  }
  entries.sort((left, right) => compareCodePoints(left[0], right[0]))
  return Object.freeze(Object.fromEntries(entries))
}

/** Copies, validates, and freezes one service instance. */
export function snapshotServiceInstance(value: ServiceInstance): ServiceInstance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("ServiceInstance must be an object")
  }
  if (!Array.isArray(value.endpoints)) {
    throw new TypeError("ServiceInstance.endpoints must be an array")
  }
  const endpoints = new Set<string>()
  for (const address of value.endpoints) {
    endpoints.add(endpoint(address))
  }
  const sortedEndpoints = Array.from(endpoints).sort(compareCodePoints)
  return Object.freeze({
    id: text(value.id, "ServiceInstance.id", false),
    name: text(value.name, "ServiceInstance.name"),
    version: text(value.version, "ServiceInstance.version", false),
    metadata: metadata(value.metadata),
    endpoints: Object.freeze(sortedEndpoints)
  })
}

/** Compares complete service identities for deterministic publication. */
function compareInstances(left: ServiceInstance, right: ServiceInstance): number {
  const byName = compareCodePoints(left.name, right.name)
  if (byName !== 0) return byName
  const byId = compareCodePoints(left.id, right.id)
  return byId === 0 ? compareCodePoints(left.version, right.version) : byId
}

/** Copies, validates, and freezes a complete service-instance snapshot. */
export function snapshotServiceInstances(
  values: readonly ServiceInstance[]
): readonly ServiceInstance[] {
  if (!Array.isArray(values)) throw new TypeError("ServiceInstance snapshot must be an array")
  const snapshots: ServiceInstance[] = []
  const identities = new Set<string>()
  for (const value of values) {
    const snapshot = snapshotServiceInstance(value)
    const identity = JSON.stringify([snapshot.name, snapshot.id])
    if (identities.has(identity)) {
      throw new TypeError("ServiceInstance snapshot contains a duplicate service identity")
    }
    identities.add(identity)
    snapshots.push(snapshot)
  }
  return Object.freeze(snapshots.sort(compareInstances))
}
