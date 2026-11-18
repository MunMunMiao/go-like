import { openConsulClient, type ConsulClient } from "../client/client"
import type { Fetch } from "@go-like/core/fetch"
import type { ConsulStoreOptions } from "./types"

/** Contains one immutable construction-time Consul provider snapshot. */
export interface CapturedOptions {
  readonly fetch: Fetch
  readonly origin: string
  readonly root: string
  readonly token: string | undefined
  readonly datacenter: string | undefined
  readonly namespace: string | undefined
}

const DefaultRoot = "go-like/store"
const MaximumRootBytes = 1_024

/** Normalizes one isolated Consul KV root without retaining empty or dot segments. */
export function consulRoot(value: string | undefined): string {
  if (value === undefined) return DefaultRoot
  if (typeof value !== "string") throw new TypeError("Consul Store root must be a string")
  let start = 0
  while (start < value.length && value.charCodeAt(start) === 47) start += 1
  let end = value.length
  while (end > start && value.charCodeAt(end - 1) === 47) end -= 1
  const root = value.slice(start, end)
  if (root.length === 0 || !root.isWellFormed()) {
    throw new TypeError("Consul Store root must be a non-empty well-formed path")
  }
  for (const segment of root.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new TypeError("Consul Store root cannot contain empty or dot path segments")
    }
  }
  if (new TextEncoder().encode(root).byteLength > MaximumRootBytes) {
    throw new RangeError(`Consul Store root exceeds ${MaximumRootBytes} UTF-8 bytes`)
  }
  return root
}

/** Captures the shared client once and the store root once, without starting I/O. */
export function captureOptions(
  client: ConsulClient,
  value: ConsulStoreOptions = {}
): CapturedOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Consul Store options must be an object")
  }
  const connection = openConsulClient(client)
  const root = value.root
  return Object.freeze({
    fetch: connection.fetch,
    origin: connection.origin,
    root: consulRoot(root),
    token: connection.token,
    datacenter: connection.datacenter,
    namespace: connection.namespace
  })
}
