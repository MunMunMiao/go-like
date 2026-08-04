import { background } from "@go-like/context"

import { decodeBase64, encodeBase64 } from "../src/codec"
import type { EtcdStoreFetch } from "../src/types"

interface FakeKeyValue {
  readonly key: string
  readonly value: string
  readonly createRevision: string
  readonly modRevision: string
  readonly version: string
  readonly lease: string
}

interface FakeLease {
  readonly ttl: number
  readonly expiresAt: number
}

interface RequestRecord {
  readonly path: string
  readonly authorization: string | null
  readonly redirect: RequestRedirect
  readonly signal: AbortSignal
  readonly body: Readonly<Record<string, unknown>>
}

interface FakeEtcdControl {
  readonly fetch: EtcdStoreFetch
  readonly requests: readonly RequestRecord[]
  readonly size: () => number
  readonly leaseCount: () => number
  readonly reset: () => void
}

interface TransactionCompare {
  readonly target?: unknown
  readonly key?: unknown
  readonly version?: unknown
  readonly mod_revision?: unknown
}

/** Reports whether one JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Returns one own data property from a test JSON carrier. */
function property(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one expected test carrier. */
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("fake etcd received an invalid JSON carrier")
  return value
}

/** Reads one required gateway string field. */
function string(value: Record<string, unknown>, key: string): string {
  const selected = property(value, key)
  if (typeof selected !== "string") throw new Error(`fake etcd omitted ${key}`)
  return selected
}

/** Decodes one gateway base64 byte string into an exact binary test key. */
function bytes(value: string): string {
  const decoded = decodeBase64(value, 1_048_576, "read")
  let result = ""
  for (const byte of decoded) result += String.fromCharCode(byte)
  return result
}

/** Encodes one exact binary test key into gateway base64. */
function encoded(value: string): string {
  const data = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    data[index] = value.charCodeAt(index)
  }
  return encodeBase64(data)
}

/** Converts one stored fake row to the etcd gateway JSON shape. */
function gatewayRow(value: FakeKeyValue, keysOnly: boolean): Readonly<Record<string, string>> {
  const entries: [string, string][] = [
    ["key", encoded(value.key)],
    ["create_revision", value.createRevision],
    ["mod_revision", value.modRevision],
    ["version", value.version],
    ["lease", value.lease]
  ]
  if (!keysOnly) entries.push(["value", value.value])
  return Object.freeze(Object.fromEntries(entries))
}

/** Creates one gateway JSON response. */
function json(value: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

/** Creates one stateful etcd v3 JSON gateway test double. */
export function fakeEtcd(): FakeEtcdControl {
  const entries = new Map<string, FakeKeyValue>()
  const leases = new Map<string, FakeLease>()
  const requests: RequestRecord[] = []
  let revision = 1n
  let leaseSequence = 100n

  /** Returns the current gateway header. */
  function header(): Readonly<Record<string, string>> {
    return Object.freeze({ revision: String(revision) })
  }

  /** Removes expired lease rows before each gateway operation. */
  function expire(): void {
    const now = Date.now()
    const expiredLeases = new Set<string>()
    for (const [id, lease] of leases) {
      if (now >= lease.expiresAt) expiredLeases.add(id)
    }
    if (expiredLeases.size === 0) return
    let removed = false
    for (const [key, value] of entries) {
      if (expiredLeases.has(value.lease)) {
        entries.delete(key)
        removed = true
      }
    }
    for (const id of expiredLeases) leases.delete(id)
    if (removed) revision += 1n
  }

  /** Selects exact range rows in binary key order. */
  function select(body: Record<string, unknown>): readonly FakeKeyValue[] {
    const start = bytes(string(body, "key"))
    const endValue = property(body, "range_end")
    let values: FakeKeyValue[]
    if (typeof endValue !== "string") {
      const exact = entries.get(start)
      values = exact === undefined ? [] : [exact]
    } else {
      const end = bytes(endValue)
      values = []
      for (const value of entries.values()) {
        if (end === "\0" ? value.key >= start : value.key >= start && value.key < end) {
          values.push(value)
        }
      }
      values.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    }
    return values
  }

  /** Creates one range response from current fake state. */
  function rangeResponse(body: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const values = select(body)
    const limitValue = property(body, "limit")
    const limit = typeof limitValue === "string" ? Number(limitValue) : values.length
    const selected = values.slice(0, limit)
    const result: [string, unknown][] = [["header", header()]]
    if (selected.length > 0) {
      const keysOnly = property(body, "keys_only") === true
      result.push(["kvs", selected.map((value) => gatewayRow(value, keysOnly))])
      result.push(["count", String(selected.length)])
    }
    if (selected.length < values.length) result.push(["more", true])
    return Object.freeze(Object.fromEntries(result))
  }

  /** Evaluates one VERSION or MOD transaction comparison. */
  function compare(value: unknown): boolean {
    const candidate: TransactionCompare = record(value)
    const key = bytes(typeof candidate.key === "string" ? candidate.key : "")
    const current = entries.get(key)
    if (candidate.target === "VERSION") {
      return String(current?.version ?? "0") === candidate.version
    }
    if (candidate.target === "MOD") {
      return current?.modRevision === candidate.mod_revision
    }
    throw new Error("fake etcd received an unsupported comparison")
  }

  /** Executes one put transaction operation after all compares pass. */
  function put(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const key = bytes(string(value, "key"))
    const encodedValue = string(value, "value")
    const leaseValue = property(value, "lease")
    const lease = typeof leaseValue === "string" ? leaseValue : "0"
    if (lease !== "0" && !leases.has(lease)) {
      throw json({ code: 5, message: "lease unavailable" }, 404)
    }
    const previous = entries.get(key)
    revision += 1n
    const next: FakeKeyValue = Object.freeze({
      key,
      value: encodedValue,
      createRevision: previous?.createRevision ?? String(revision),
      modRevision: String(revision),
      version: String(BigInt(previous?.version ?? "0") + 1n),
      lease
    })
    entries.set(key, next)
    const response: [string, unknown][] = [["header", header()]]
    if (property(value, "prev_kv") === true && previous !== undefined) {
      response.push(["prev_kv", gatewayRow(previous, false)])
    }
    return Object.freeze(Object.fromEntries(response))
  }

  /** Executes one delete-range transaction operation after comparison success. */
  function remove(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const key = bytes(string(value, "key"))
    const previous = entries.get(key)
    if (previous !== undefined) {
      entries.delete(key)
      revision += 1n
    }
    const response: [string, unknown][] = [
      ["header", header()],
      ["deleted", previous === undefined ? "0" : "1"]
    ]
    if (property(value, "prev_kv") === true && previous !== undefined) {
      response.push(["prev_kvs", [gatewayRow(previous, false)]])
    }
    return Object.freeze(Object.fromEntries(response))
  }

  /** Executes one compare-and-operation transaction. */
  function transaction(body: Record<string, unknown>): Response {
    const comparisons = property(body, "compare")
    const success = property(body, "success")
    const failure = property(body, "failure")
    if (!Array.isArray(comparisons) || !Array.isArray(success) || !Array.isArray(failure)) {
      throw new Error("fake etcd received an invalid transaction")
    }
    const succeeded = comparisons.every(compare)
    const operations = succeeded ? success : failure
    const selected = operations[0]
    if (operations.length !== 1 || !isRecord(selected)) {
      throw new Error("fake etcd requires exactly one transaction operation")
    }
    let operationResponse: Readonly<Record<string, unknown>>
    const putValue = property(selected, "request_put")
    const deleteValue = property(selected, "request_delete_range")
    const rangeValue = property(selected, "request_range")
    try {
      if (isRecord(putValue)) {
        operationResponse = Object.freeze({ response_put: put(putValue) })
      } else if (isRecord(deleteValue)) {
        operationResponse = Object.freeze({ response_delete_range: remove(deleteValue) })
      } else if (isRecord(rangeValue)) {
        operationResponse = Object.freeze({ response_range: rangeResponse(rangeValue) })
      } else {
        throw new Error("fake etcd received an unknown transaction operation")
      }
    } catch (value) {
      if (value instanceof Response) return value
      throw value
    }
    const response: [string, unknown][] = [["header", header()]]
    if (succeeded) response.push(["succeeded", true])
    response.push(["responses", [operationResponse]])
    return json(Object.fromEntries(response))
  }

  /** Implements the borrowed standard Fetch boundary. */
  const fetch: EtcdStoreFetch = async function fetch(request): Promise<Response> {
    expire()
    const bodyValue: unknown = await request.json()
    const body = record(bodyValue)
    const url = new URL(request.url)
    requests.push(
      Object.freeze({
        path: url.pathname,
        authorization: request.headers.get("Authorization"),
        redirect: request.redirect,
        signal: request.signal,
        body: Object.freeze(Object.fromEntries(Object.entries(body)))
      })
    )
    if (url.pathname === "/v3/kv/range") return json(rangeResponse(body))
    if (url.pathname === "/v3/kv/txn") return transaction(body)
    if (url.pathname === "/v3/lease/grant") {
      const ttl = Number(string(body, "TTL"))
      leaseSequence += 1n
      const id = String(leaseSequence)
      leases.set(id, Object.freeze({ ttl, expiresAt: Date.now() + ttl * 1_000 }))
      return json({ ID: id, TTL: String(ttl) })
    }
    if (url.pathname === "/v3/lease/revoke") {
      const id = string(body, "ID")
      if (!leases.has(id)) return json({ code: 5, message: "lease unavailable" }, 404)
      leases.delete(id)
      let removed = false
      for (const [key, value] of entries) {
        if (value.lease === id) {
          entries.delete(key)
          removed = true
        }
      }
      if (removed) revision += 1n
      return json({ header: header() })
    }
    return json({ code: 12, message: "route unavailable" }, 404)
  }

  return Object.freeze({
    fetch,
    get requests(): readonly RequestRecord[] {
      return Object.freeze(Array.from(requests))
    },
    /** Returns the number of live keys after applying lease expiry. */
    size(): number {
      expire()
      return entries.size
    },
    /** Returns the number of live leases after applying expiry. */
    leaseCount(): number {
      expire()
      return leases.size
    },
    /** Clears all fake remote state and observations. */
    reset(): void {
      entries.clear()
      leases.clear()
      requests.length = 0
      revision = 1n
      leaseSequence = 100n
    }
  })
}

/** Waits at least one selected test duration. */
export function delay(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
}
