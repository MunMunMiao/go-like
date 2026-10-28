import type { VaultFetch } from "../src/index"

interface StoredVersion {
  readonly version: number
  readonly data: Readonly<Record<string, unknown>>
  deleted: boolean
}

type FailureMode =
  | "normal"
  | "write-lost-before"
  | "write-lost-after"
  | "write-503-after"
  | "delete-lost-before"
  | "delete-lost-after"
  | "delete-503-after"
  | "concurrent-before-delete"
  | "malformed-list"
  | "malformed-read"
  | "malformed-write"
  | "deny"

export interface FakeVault {
  readonly fetch: VaultFetch
  readonly requests: Request[]
  readonly setFailure: (mode: FailureMode) => void
  readonly visible: (logicalPhysicalKey: string) => StoredVersion | null
}

function own(value: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(value, name)?.value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Creates one deterministic in-memory Vault KV v2 HTTP model. */
export function fakeVault(): FakeVault {
  const values = new Map<string, StoredVersion[]>()
  const requests: Request[] = []
  let failure: FailureMode = "normal"

  /** Returns and clears one matching one-shot failure mode. */
  function take(mode: FailureMode): boolean {
    if (failure !== mode) return false
    failure = "normal"
    return true
  }

  /** Returns one current stored version even when soft-deleted. */
  function current(key: string): StoredVersion | null {
    return values.get(key)?.at(-1) ?? null
  }

  /** Writes one new physical version from a validated Vault request carrier. */
  function append(key: string, data: Readonly<Record<string, unknown>>): StoredVersion {
    const versions = values.get(key) ?? []
    const value: StoredVersion = { version: versions.length + 1, data, deleted: false }
    versions.push(value)
    values.set(key, versions)
    return value
  }

  /** Parses one request body as a JSON object. */
  async function body(request: Request): Promise<Record<string, unknown>> {
    const value: unknown = await request.json()
    if (!record(value)) throw new Error("invalid fake Vault body")
    return value
  }

  /** Creates one Vault data response for the selected physical version. */
  function dataResponse(value: StoredVersion): Response {
    return Response.json({
      data: {
        data: value.deleted ? null : value.data,
        metadata: {
          version: value.version,
          deletion_time: value.deleted ? "2026-07-22T00:00:00Z" : ""
        }
      }
    })
  }

  /** Handles one standard Fetch request through Vault KV v2 routes. */
  const fetch: VaultFetch = async function fetchVault(request): Promise<Response> {
    requests.push(request.clone())
    if (take("deny")) return new Response(null, { status: 403 })
    const url = new URL(request.url)
    const match = /^\/v1\/secret\/(data|delete|metadata)\/go-like\/store(?:\/([^/]+))?$/u.exec(
      url.pathname
    )
    if (match === null) return new Response(null, { status: 404 })
    const role = match[1]
    const key = match[2] ?? null
    if (
      role === "metadata" &&
      request.method === "GET" &&
      url.searchParams.get("list") === "true" &&
      key === null
    ) {
      if (take("malformed-list")) return Response.json({ data: { keys: ["!"] } })
      if (values.size === 0) return new Response(null, { status: 404 })
      return Response.json({ data: { keys: Array.from(values.keys()) } })
    }
    if (role === "data" && request.method === "GET" && key !== null) {
      if (take("malformed-read")) return Response.json({ data: { data: 1 } })
      const selectedVersion = url.searchParams.get("version")
      const value =
        selectedVersion === null
          ? current(key)
          : (values.get(key)?.find((candidate) => String(candidate.version) === selectedVersion) ??
            null)
      if (value === null || (selectedVersion === null && value.deleted)) {
        return new Response(null, { status: 404 })
      }
      return dataResponse(value)
    }
    if (role === "data" && request.method === "POST" && key !== null) {
      if (take("write-lost-before")) throw new Error("write response lost before commit")
      const envelope = await body(request)
      const data = own(envelope, "data")
      if (!record(data)) return new Response(null, { status: 400 })
      const written = append(key, data)
      if (take("write-lost-after")) throw new Error("write response lost after commit")
      if (take("write-503-after")) return new Response(null, { status: 503 })
      if (take("malformed-write")) return Response.json({ data: {} })
      return Response.json({ data: { version: written.version } })
    }
    if (role === "delete" && request.method === "POST" && key !== null) {
      if (take("delete-lost-before")) throw new Error("delete response lost before commit")
      const envelope = await body(request)
      const versions = own(envelope, "versions")
      if (!Array.isArray(versions) || typeof versions[0] !== "number") {
        return new Response(null, { status: 400 })
      }
      if (take("concurrent-before-delete")) {
        append(key, {
          version: 1,
          operation: "concurrent",
          value: "CQ==",
          metadata: {}
        })
      }
      const selected = values.get(key)?.find((candidate) => candidate.version === versions[0])
      if (selected !== undefined) selected.deleted = true
      if (take("delete-lost-after")) throw new Error("delete response lost after commit")
      if (take("delete-503-after")) return new Response(null, { status: 503 })
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 405 })
  }

  return Object.freeze({
    fetch,
    requests,
    setFailure(mode: FailureMode): void {
      failure = mode
    },
    visible(key: string): StoredVersion | null {
      const value = current(key)
      return value === null || value.deleted ? null : value
    }
  })
}
