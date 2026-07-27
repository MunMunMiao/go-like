import type { VaultFetch, VaultStoreOptions } from "./types"

/** Contains one immutable construction-time Vault option snapshot. */
export interface CapturedOptions {
  readonly fetch: VaultFetch
  readonly origin: string
  readonly mount: string
  readonly root: string
  readonly token: string | undefined
  readonly namespace: string | undefined
  readonly cursorTtlMs: number
}

const DefaultRoot = "likego/store"
const DefaultCursorTtlMs = 60_000
const MaximumCursorTtlMs = 600_000

/** Reports whether one string contains only complete UTF-16 scalar sequences. */
function isWellFormed(value: string): boolean {
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

/** Validates one optional HTTP header value without reflecting it. */
function optionalHeader(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Vault Store ${name} must be a non-empty string`)
  }
  try {
    const headers = new Headers()
    headers.set(name, value)
  } catch {
    throw new TypeError(`Vault Store ${name} must be a valid HTTP header value`)
  }
  return value
}

/** Encodes one slash-separated Vault path while rejecting normalized dot segments. */
function encodedPath(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormed(value) ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    throw new TypeError(`Vault Store ${name} must be a non-empty relative path`)
  }
  const encoded: string[] = []
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new TypeError(`Vault Store ${name} contains an invalid path segment`)
    }
    encoded.push(encodeURIComponent(segment))
  }
  return encoded.join("/")
}

/** Captures one credentials-free Vault HTTP origin. */
function vaultOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("Vault Store address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Vault Store address must be a valid HTTP or HTTPS origin")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      "Vault Store address must be an HTTP or HTTPS origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Captures every construction option once without starting I/O. */
export function captureOptions(value: VaultStoreOptions): CapturedOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Vault Store options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const mount = value.mount
  const root = value.root ?? DefaultRoot
  const token = value.token
  const namespace = value.namespace
  const cursorTtlMs = value.cursorTtlMs ?? DefaultCursorTtlMs
  if (typeof fetch !== "function") throw new TypeError("Vault Store Fetch must be callable")
  if (!Number.isSafeInteger(cursorTtlMs) || cursorTtlMs < 1 || cursorTtlMs > MaximumCursorTtlMs) {
    throw new RangeError(`Vault Store cursorTtlMs must be from 1 through ${MaximumCursorTtlMs}`)
  }
  return Object.freeze({
    fetch,
    origin: vaultOrigin(address),
    mount: encodedPath(mount, "mount"),
    root: encodedPath(root, "root"),
    token: optionalHeader(token, "X-Vault-Token"),
    namespace: optionalHeader(namespace, "X-Vault-Namespace"),
    cursorTtlMs
  })
}
