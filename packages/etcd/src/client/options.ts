import type { Fetch } from "@go-like/core/fetch"

/** Immutable connection captured once by newEtcdClient. */
export interface Connection {
  readonly fetch: Fetch
  readonly origin: string
  readonly token: string | undefined
}

/** Canonicalizes one credentials-free, path-free HTTP(S) origin. */
export function etcdOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("etcd address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("etcd address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("etcd address must use HTTP or HTTPS")
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
      "etcd address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Validates one optional token as the raw Authorization header value. */
function authorizationToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TypeError("etcd token must be a non-empty HTTP header value")
  }
  try {
    const headers = new Headers()
    headers.set("Authorization", value)
  } catch {
    throw new TypeError("etcd token must be a valid HTTP header value")
  }
  return value
}

/** Captures fetch, origin, and token once, before any I/O. */
export function captureConnection(value: {
  readonly fetch: Fetch
  readonly address: string
  readonly token?: string
}): Connection {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("etcd client options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const token = value.token
  if (typeof fetch !== "function") throw new TypeError("etcd Fetch capability must be callable")
  return Object.freeze({
    fetch,
    origin: etcdOrigin(address),
    token: authorizationToken(token)
  })
}
