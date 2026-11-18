import type { Fetch } from "@go-like/core/fetch"

/** Immutable connection captured once by newVaultClient. */
export interface Connection {
  readonly fetch: Fetch
  readonly origin: string
  readonly token: string | undefined
  readonly namespace: string | undefined
}

/**
 * Validates one optional Vault header value.
 * Keeps the config well-formed check and the store header-byte check.
 */
function headerValue(value: unknown, label: string, header: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new TypeError(`Vault ${label} must be a non-empty HTTP header value`)
  }
  try {
    const headers = new Headers()
    headers.set(header, value)
  } catch {
    throw new TypeError(`Vault ${label} must be a non-empty HTTP header value`)
  }
  return value
}

/**
 * Canonicalizes one credentials-free, path-free HTTP(S) origin.
 * Keeps every config and store rejection; protocol is reported separately.
 */
export function vaultOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("Vault address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Vault address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Vault address must use HTTP or HTTPS")
  }
  const invalidOrigin = [
    url.username !== "",
    url.password !== "",
    url.pathname !== "/",
    url.pathname !== "" && url.pathname !== "/",
    url.search !== "",
    url.hash !== "",
    value.includes("?"),
    value.includes("#"),
    url.href.includes("?"),
    url.href.includes("#")
  ].includes(true)
  if (invalidOrigin) {
    throw new TypeError(
      "Vault address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Captures fetch, origin, token, and namespace once, before any I/O. */
export function captureConnection(value: {
  readonly fetch: Fetch
  readonly address: string
  readonly token?: string
  readonly namespace?: string
}): Connection {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Vault client options must be an object")
  }
  let fetch: Fetch
  let address: string
  let token: unknown
  let namespace: unknown
  try {
    fetch = value.fetch
    address = value.address
    token = value.token
    namespace = value.namespace
  } catch {
    throw new TypeError("Vault client options could not be read")
  }
  if (typeof fetch !== "function") throw new TypeError("Vault Fetch capability must be callable")
  return Object.freeze({
    fetch,
    origin: vaultOrigin(address),
    token: headerValue(token, "token", "X-Vault-Token"),
    namespace: headerValue(namespace, "namespace", "X-Vault-Namespace")
  })
}
