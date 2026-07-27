import type { ConsulFetch, ConsulStoreOptions } from "./types"

/** Contains one immutable construction-time Consul provider snapshot. */
export interface CapturedOptions {
  readonly fetch: ConsulFetch
  readonly origin: string
  readonly root: string
  readonly token: string | undefined
  readonly datacenter: string | undefined
  readonly namespace: string | undefined
}

const DefaultRoot = "likego/store"
const MaximumRootBytes = 1_024

/** Reports whether one string contains only complete UTF-16 scalar sequences. */
export function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Normalizes one isolated Consul KV root without retaining empty or dot segments. */
export function consulRoot(value: string | undefined): string {
  if (value === undefined) return DefaultRoot
  if (typeof value !== "string") throw new TypeError("Consul Store root must be a string")
  const root = value.replace(/^\/+|\/+$/gu, "")
  if (root.length === 0 || !isWellFormed(root)) {
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

/** Validates one optional non-empty Consul scope without normalization. */
function optionalScope(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`Consul Store ${name} must be a non-empty string`)
  }
  return value
}

/** Validates one ACL token as a standard HTTP header without reflecting its bytes. */
function aclToken(value: string | undefined): string | undefined {
  optionalScope(value, "token")
  if (value === undefined) return undefined
  try {
    const headers = new Headers()
    headers.set("X-Consul-Token", value)
  } catch {
    throw new TypeError("Consul Store token must be a valid HTTP header value")
  }
  return value
}

/** Canonicalizes one credentials-free and path-free Consul HTTP origin. */
export function consulOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("Consul Store address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Consul Store address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Consul Store address must use HTTP or HTTPS")
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      "Consul Store address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Captures each constructor property once without starting provider I/O. */
export function captureOptions(value: ConsulStoreOptions): CapturedOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Consul Store options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const root = value.root
  const token = value.token
  const datacenter = value.datacenter
  const namespace = value.namespace
  if (typeof fetch !== "function") throw new TypeError("Consul Store Fetch must be callable")
  return Object.freeze({
    fetch,
    origin: consulOrigin(address),
    root: consulRoot(root),
    token: aclToken(token),
    datacenter: optionalScope(datacenter, "datacenter"),
    namespace: optionalScope(namespace, "namespace")
  })
}
