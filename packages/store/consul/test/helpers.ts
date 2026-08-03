import { encodeBase64 } from "../src/codec"
import type { ConsulFetch } from "../src/index"

interface FakeRow {
  readonly key: string
  payload: string
  revision: number
  session: string | null
}

interface FakeSession {
  readonly id: string
  readonly name: string
  readonly ttlMs: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Records one secret-inspectable request snapshot for test assertions. */
export interface RequestTrace {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly redirect: RequestRedirect
  readonly body: string | null
}

/** Exposes one isolated in-memory Consul HTTP behavior model. */
export interface FakeConsul {
  readonly fetch: ConsulFetch
  readonly requests: readonly RequestTrace[]
  /** Returns the current exact KV/session counts. */
  counts(): { readonly keys: number; readonly sessions: number }
  /** Clears every fake session timer and remote carrier. */
  reset(): void
}

/** Reads one own JSON data property. */
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Encodes one UTF-8 string as the Consul response's standard base64 Value. */
function encodedValue(value: string): string {
  return encodeBase64(new TextEncoder().encode(value))
}

/** Creates one Consul JSON row from retained fake state. */
function responseRow(row: FakeRow): object {
  return {
    CreateIndex: row.revision,
    ModifyIndex: row.revision,
    LockIndex: row.session === null ? 0 : 1,
    Key: row.key,
    Flags: 0,
    Value: encodedValue(row.payload),
    Session: row.session
  }
}

/** Decodes one complete percent-encoded KV path. */
function requestKey(pathname: string): string {
  return decodeURIComponent(pathname.slice("/v1/kv/".length))
}

/** Creates one isolated deterministic Consul KV/Session Fetch model. */
export function fakeConsul(): FakeConsul {
  const rows = new Map<string, FakeRow>()
  const sessions = new Map<string, FakeSession>()
  const requests: RequestTrace[] = []
  let revision = 10
  let nextSession = 1

  /** Deletes one session and each behavior-delete lock it currently owns. */
  function removeSession(id: string): void {
    const session = sessions.get(id)
    if (session === undefined) return
    if (session.timer !== null) clearTimeout(session.timer)
    sessions.delete(id)
    for (const [key, row] of rows) {
      if (row.session === id) rows.delete(key)
    }
  }

  /** Schedules accelerated fake expiry while preserving the advertised real TTL. */
  function scheduleExpiry(session: FakeSession): void {
    if (session.timer !== null) clearTimeout(session.timer)
    session.timer = setTimeout(function expireSession(): void {
      removeSession(session.id)
    }, 30)
  }

  /** Writes one fake KV row and returns Consul's boolean mutation body. */
  async function putKey(request: Request, url: URL, key: string): Promise<Response> {
    const payload = await request.text()
    const current = rows.get(key)
    const cas = url.searchParams.get("cas")
    const acquire = url.searchParams.get("acquire")
    const release = url.searchParams.get("release")
    if (cas !== null && String(current?.revision ?? 0) !== cas) return new Response("false")
    if (
      acquire !== null &&
      current !== undefined &&
      current.session !== null &&
      current.session !== acquire
    ) {
      return new Response("false")
    }
    if (release !== null && current?.session !== release) return new Response("false")
    revision += 1
    let session = current?.session ?? null
    if (acquire !== null) session = acquire
    if (release !== null) session = null
    rows.set(key, { key, payload, revision, session })
    if (acquire !== null) {
      const owner = sessions.get(acquire)
      if (owner !== undefined) scheduleExpiry(owner)
    }
    return new Response("true")
  }

  /** Deletes one fake KV row with optional ModifyIndex CAS. */
  function deleteKey(url: URL, key: string): Response {
    const current = rows.get(key)
    const cas = url.searchParams.get("cas")
    if (cas !== null && String(current?.revision ?? 0) !== cas) return new Response("false")
    rows.delete(key)
    revision += 1
    return new Response("true")
  }

  /** Serves one exact or recursive fake KV query. */
  function getKey(url: URL, key: string): Response {
    const headers = { "X-Consul-Index": String(revision) }
    if (url.searchParams.has("recurse")) {
      const found: object[] = []
      for (const row of rows.values()) {
        if (row.key.startsWith(key)) found.push(responseRow(row))
      }
      return found.length === 0
        ? new Response(null, { status: 404, headers })
        : Response.json(found, { headers })
    }
    const row = rows.get(key)
    return row === undefined
      ? new Response(null, { status: 404, headers })
      : Response.json([responseRow(row)], { headers })
  }

  /** Creates one fake behavior-delete TTL session. */
  async function createFakeSession(request: Request): Promise<Response> {
    const value: unknown = await request.json()
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return new Response("invalid", { status: 400 })
    }
    const name = own(value, "Name")
    const rawTtl = own(value, "TTL")
    if (typeof name !== "string" || typeof rawTtl !== "string") {
      return new Response("invalid", { status: 400 })
    }
    const ttlMs = Number(rawTtl.replace(/ms$/u, ""))
    const id = `00000000-0000-0000-0000-${String(nextSession).padStart(12, "0")}`
    nextSession += 1
    sessions.set(id, { id, name, ttlMs, timer: null })
    return Response.json({ ID: id })
  }

  /** Returns all fake sessions in the Consul session-list shape. */
  function listFakeSessions(): Response {
    const values: object[] = []
    for (const session of sessions.values()) {
      values.push({ ID: session.id, Name: session.name, TTL: `${session.ttlMs}ms` })
    }
    return Response.json(values)
  }

  /** Serves the complete fake Consul HTTP surface needed by the provider. */
  const fetch: ConsulFetch = async function fetchConsul(request): Promise<Response> {
    const body = request.method === "GET" ? null : await request.clone().text()
    requests.push(
      Object.freeze({
        method: request.method,
        url: request.url,
        headers: new Headers(request.headers),
        redirect: request.redirect,
        body
      })
    )
    if (request.signal.aborted) throw request.signal.reason
    const url = new URL(request.url)
    if (url.pathname.startsWith("/v1/kv/")) {
      const key = requestKey(url.pathname)
      if (request.method === "GET") return getKey(url, key)
      if (request.method === "PUT") return await putKey(request, url, key)
      if (request.method === "DELETE") return deleteKey(url, key)
    }
    if (url.pathname === "/v1/session/create" && request.method === "PUT") {
      return await createFakeSession(request)
    }
    if (url.pathname === "/v1/session/list" && request.method === "GET") {
      return listFakeSessions()
    }
    if (url.pathname.startsWith("/v1/session/info/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/v1/session/info/".length))
      const session = sessions.get(id)
      return Response.json(session === undefined ? [] : [{ ID: id, Name: session.name }])
    }
    if (url.pathname.startsWith("/v1/session/destroy/") && request.method === "PUT") {
      const id = decodeURIComponent(url.pathname.slice("/v1/session/destroy/".length))
      removeSession(id)
      return new Response("true")
    }
    return new Response("unsupported", { status: 404 })
  }

  return Object.freeze({
    fetch,
    requests,
    /** Returns exact fake remote resource counts. */
    counts(): { readonly keys: number; readonly sessions: number } {
      return Object.freeze({ keys: rows.size, sessions: sessions.size })
    },
    /** Clears all fake remote resources and their timers. */
    reset(): void {
      for (const session of Array.from(sessions.values())) removeSession(session.id)
      rows.clear()
    }
  })
}
