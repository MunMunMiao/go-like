import type { EtcdStoreFetch, EtcdStoreOptions } from "./types"

/** Contains one immutable construction-time etcd Store snapshot. */
export interface CapturedOptions {
  readonly fetch: EtcdStoreFetch
  readonly origin: string
  readonly token: string | undefined
}

/** Canonicalizes one credentials-free and route-free HTTP(S) origin. */
export function etcdStoreOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("etcd Store address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("etcd Store address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("etcd Store address must use HTTP or HTTPS")
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
      "etcd Store address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Validates one optional token at the exact Authorization header boundary. */
function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("etcd Store token must be a non-empty string")
  }
  try {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${value}`)
  } catch {
    throw new TypeError("etcd Store token must be a valid HTTP header value")
  }
  return value
}

/** Captures every constructor field once without starting network I/O. */
export function captureOptions(value: EtcdStoreOptions): CapturedOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("etcd Store options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const token = value.token
  if (typeof fetch !== "function") throw new TypeError("etcd Store Fetch must be callable")
  return Object.freeze({ fetch, origin: etcdStoreOrigin(address), token: bearerToken(token) })
}
