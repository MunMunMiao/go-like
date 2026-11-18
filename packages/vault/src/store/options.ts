import { openVaultClient, type VaultClient } from "../client/client"
import type { Fetch } from "@go-like/core/fetch"
import type { VaultStoreOptions } from "./types"

/** Contains one immutable construction-time Vault option snapshot. */
export interface CapturedOptions {
  readonly fetch: Fetch
  readonly origin: string
  readonly mount: string
  readonly root: string
  readonly token: string | undefined
  readonly namespace: string | undefined
  readonly cursorTtlMs: number
}

const DefaultRoot = "go-like/store"
const DefaultCursorTtlMs = 60_000
const MaximumCursorTtlMs = 600_000

/** Encodes one slash-separated Vault path while rejecting normalized dot segments. */
function encodedPath(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.isWellFormed() ||
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

/** Captures the shared client once and the store mount once, without starting I/O. */
export function captureOptions(client: VaultClient, value: VaultStoreOptions): CapturedOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Vault Store options must be an object")
  }
  const connection = openVaultClient(client)
  const mount = value.mount
  const root = value.root ?? DefaultRoot
  const cursorTtlMs = value.cursorTtlMs ?? DefaultCursorTtlMs
  if (!Number.isSafeInteger(cursorTtlMs) || cursorTtlMs < 1 || cursorTtlMs > MaximumCursorTtlMs) {
    throw new RangeError(`Vault Store cursorTtlMs must be from 1 through ${MaximumCursorTtlMs}`)
  }
  return Object.freeze({
    fetch: connection.fetch,
    origin: connection.origin,
    mount: encodedPath(mount, "mount"),
    root: encodedPath(root, "root"),
    token: connection.token,
    namespace: connection.namespace,
    cursorTtlMs
  })
}
