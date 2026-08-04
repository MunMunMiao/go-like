import { describe, expect, test } from "bun:test"

import { background } from "@go-like/context"
import { cursor, expiresIn, ifAbsent, ifRevision, limit, prefix } from "@go-like/store"

import { encodeBase64, encodeRecordPayload } from "../src/codec"
import { newConsulStore, type ConsulFetch } from "../src/index"
import { fakeConsul } from "./helpers"

/** Creates one valid Consul row for scripted expiry behavior. */
function expiredRow(key: string, revision: number, session: string | null): object {
  const payload = encodeRecordPayload(
    { key, value: Uint8Array.of(1), metadata: {} },
    "expired-operation",
    Date.now() - 1
  )
  return {
    Key: `go-like/store/${key}`,
    ModifyIndex: revision,
    Value: encodeBase64(new TextEncoder().encode(payload)),
    Session: session
  }
}

/** Creates one visible Consul row for a scripted competing writer. */
function activeRow(key: string, revision: number): object {
  const payload = encodeRecordPayload(
    { key, value: Uint8Array.of(2), metadata: {} },
    "competing-operation",
    null
  )
  return {
    Key: `go-like/store/${key}`,
    ModifyIndex: revision,
    Value: encodeBase64(new TextEncoder().encode(payload)),
    Session: null
  }
}

describe("Consul Store CRUD, CAS, and pagination", () => {
  test("isolates physical roots, ignores external KV, and fails closed on corrupt owned data", async () => {
    const backend = fakeConsul()
    const external = await backend.fetch(
      new Request("http://consul.test/v1/kv/external/service", {
        method: "PUT",
        body: "not-owned"
      })
    )
    expect(await external.text()).toBe("true")

    const first = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const second = newConsulStore({
      fetch: backend.fetch,
      address: "http://consul.test",
      root: "/tenant/two/"
    })
    expect((await first.list(background())).records).toEqual([])
    expect((await second.list(background())).records).toEqual([])

    await first.write(background(), { key: "shared", value: Uint8Array.of(1) })
    await first.write(background(), { key: "shared-next", value: Uint8Array.of(3) })
    await second.write(background(), { key: "shared", value: Uint8Array.of(2) })
    expect(Array.from((await first.read(background(), "shared"))?.value ?? [])).toEqual([1])
    expect(Array.from((await second.read(background(), "shared"))?.value ?? [])).toEqual([2])
    const firstPage = await first.list(background(), limit(1))
    if (firstPage.cursor === null) throw new Error("isolated root cursor missing")
    await expect(second.list(background(), cursor(firstPage.cursor))).rejects.toThrow(
      "cursor is invalid"
    )

    const corrupt = await backend.fetch(
      new Request("http://consul.test/v1/kv/go-like/store/corrupt", {
        method: "PUT",
        body: "not-a-go-like-envelope"
      })
    )
    expect(await corrupt.text()).toBe("true")
    await expect(first.list(background())).rejects.toMatchObject({
      code: "GO_LIKE_CONSUL_STORE_PROTOCOL",
      operation: "list"
    })
    const removed = await backend.fetch(
      new Request("http://consul.test/v1/kv/go-like/store/corrupt", { method: "DELETE" })
    )
    expect(await removed.text()).toBe("true")

    expect(await first.delete(background(), "shared")).toBe(true)
    expect(await first.delete(background(), "shared-next")).toBe(true)
    expect(await second.delete(background(), "shared")).toBe(true)
    expect(backend.counts()).toEqual({ keys: 1, sessions: 0 })
    backend.reset()
  })

  test("round-trips detached payloads and uses ModifyIndex as the opaque revision", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const value = Uint8Array.of(0, 1, 255)
    const metadata = { region: "华东" }
    const written = await store.write(background(), { key: "orders/一", value, metadata })
    value[0] = 9
    metadata.region = "mutated"

    expect(written.key).toBe("orders/一")
    expect(written.revision).toMatch(/^\d+$/)
    expect(Array.from(written.value)).toEqual([0, 1, 255])
    expect(written.metadata).toEqual({ region: "华东" })
    expect(written.expiresAt).toBeNull()
    const put = backend.requests.find(function putRequest(request) {
      return request.method === "PUT" && new URL(request.url).pathname.includes("orders")
    })
    if (put?.body === null || put?.body === undefined) throw new Error("KV PUT body missing")
    const wire = JSON.parse(put.body)
    expect(wire).toMatchObject({
      version: 1,
      value: "AAH/",
      metadata: { region: "华东" },
      expiresAt: null
    })
    expect(typeof wire.operation).toBe("string")
    expect(wire.operation.length).toBeGreaterThan(0)

    const read = await store.read(background(), "orders/一")
    expect(read).toEqual(written)
    expect(read).not.toBe(written)
    if (read === null) throw new Error("read record missing")
    read.value[0] = 7
    expect(Array.from((await store.read(background(), "orders/一"))?.value ?? [])).toEqual([
      0, 1, 255
    ])
    expect(await store.delete(background(), "orders/一")).toBe(true)
    expect(await store.delete(background(), "orders/一")).toBe(false)
    expect(await store.read(background(), "orders/一")).toBeNull()
    expect(backend.counts()).toEqual({ keys: 0, sessions: 0 })
    backend.reset()
  })

  test("enforces shared-writer CAS for write and delete", async () => {
    const backend = fakeConsul()
    const first = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const second = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const initial = await first.write(background(), { key: "cas", value: Uint8Array.of(1) })
    const updated = await second.write(
      background(),
      { key: "cas", value: Uint8Array.of(2) },
      ifRevision(initial.revision)
    )
    expect(updated.revision).not.toBe(initial.revision)
    await expect(
      first.write(
        background(),
        { key: "cas", value: Uint8Array.of(3) },
        ifRevision(initial.revision)
      )
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      expectedRevision: initial.revision,
      actualRevision: updated.revision
    })
    await expect(
      first.write(background(), { key: "missing", value: Uint8Array.of(1) }, ifRevision("999"))
    ).rejects.toMatchObject({ code: "GO_LIKE_STORE_CONFLICT", actualRevision: null })
    await expect(
      first.delete(background(), "cas", ifRevision(initial.revision))
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      actualRevision: updated.revision
    })
    expect(await first.delete(background(), "cas", ifRevision(updated.revision))).toBe(true)
    await expect(
      first.delete(background(), "cas", ifRevision(updated.revision))
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      actualRevision: null
    })
    backend.reset()
  })

  test("sorts Unicode code points, binds opaque cursors to prefixes, and preserves persistent data", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    for (const key of ["p/😀", "p/a", "other", "p/中", "p/A"]) {
      await store.write(background(), { key, value: new TextEncoder().encode(key) })
    }
    const first = await store.list(background(), prefix("p/"), limit(2))
    expect(first.records.map((record) => record.key)).toEqual(["p/A", "p/a"])
    expect(first.cursor).not.toBeNull()
    if (first.cursor === null) throw new Error("cursor missing")
    const second = await store.list(background(), prefix("p/"), limit(2), cursor(first.cursor))
    expect(second.records.map((record) => record.key)).toEqual(["p/中", "p/😀"])
    expect(second.cursor).toBeNull()
    const stale = await store.list(background(), prefix("p/"), limit(1))
    if (stale.cursor === null) throw new Error("stale cursor missing")
    await store.write(background(), { key: "p/new", value: Uint8Array.of(1) })
    await expect(
      store.list(background(), prefix("p/"), limit(1), cursor(stale.cursor))
    ).rejects.toThrow("cursor is stale")
    await expect(store.list(background(), prefix("other/"), cursor(first.cursor))).rejects.toThrow(
      "cursor is invalid"
    )
    await expect(store.list(background(), limit(1_001))).rejects.toBeInstanceOf(RangeError)
    expect(backend.counts()).toEqual({ keys: 6, sessions: 0 })
    backend.reset()
  })

  test("validates key, value, TTL, payload, and provider bounds before mutation", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const before = backend.requests.length
    await expect(store.read(background(), "")).rejects.toThrow("well-formed string")
    const invalidKeys = ["", "a/./b", "a/../b", "\ud800", "\udc00", "x".repeat(1_025)]
    for (const key of invalidKeys) {
      await expect(
        store.write(background(), { key, value: Uint8Array.of(1) })
      ).rejects.toBeInstanceOf(Error)
    }
    await expect(
      store.write(background(), { key: "large", value: new Uint8Array(393_127) })
    ).rejects.toThrow("value exceeds")
    await expect(
      store.write(background(), {
        key: "payload",
        value: Uint8Array.of(1),
        metadata: { huge: "x".repeat(524_288) }
      })
    ).rejects.toThrow("encoded record exceeds")
    await expect(
      store.write(background(), { key: "short-ttl", value: Uint8Array.of(1) }, expiresIn(9_999))
    ).rejects.toThrow("ttl must be between")
    await expect(
      store.write(background(), { key: "long-ttl", value: Uint8Array.of(1) }, expiresIn(86_400_001))
    ).rejects.toThrow("ttl must be between")
    expect(backend.requests).toHaveLength(before)

    const maximum = await store.write(background(), {
      key: "maximum-value",
      value: new Uint8Array(393_126)
    })
    expect(maximum.value.byteLength).toBe(393_126)
    await store.delete(background(), "maximum-value")

    expect(store.string()).toBe("consul")
    backend.reset()
  })
})

describe("Consul Store TTL sessions", () => {
  test("uses behavior-delete sessions, hides expiry, and early delete releases exactly its session", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const ttlRecord = await store.write(
      background(),
      { key: "ttl", value: Uint8Array.of(1) },
      expiresIn(10_000)
    )
    expect(ttlRecord.expiresAt).toBeGreaterThan(Date.now())
    expect(backend.counts()).toEqual({ keys: 1, sessions: 1 })
    const sessionCreate = backend.requests.find(function created(request) {
      return new URL(request.url).pathname === "/v1/session/create"
    })
    if (sessionCreate?.body === null || sessionCreate?.body === undefined) {
      throw new Error("session body missing")
    }
    expect(JSON.parse(sessionCreate.body)).toMatchObject({
      Behavior: "delete",
      TTL: "10000ms",
      LockDelay: "0s",
      NodeChecks: []
    })
    const acquire = backend.requests.find(function acquired(request) {
      return new URL(request.url).searchParams.has("acquire")
    })
    expect(acquire).toBeDefined()
    expect(await store.delete(background(), "ttl")).toBe(true)
    expect(backend.counts()).toEqual({ keys: 0, sessions: 0 })

    await store.write(background(), { key: "expires", value: Uint8Array.of(2) }, expiresIn(10_000))
    await new Promise<void>(function wait(resolve): void {
      setTimeout(resolve, 40)
    })
    expect(await store.read(background(), "expires")).toBeNull()
    expect((await store.list(background())).records).toEqual([])
    backend.reset()
  })

  test("does not tie business TTL sessions to one client lifetime", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    await store.write(
      background(),
      { key: "survives-client", value: Uint8Array.of(1) },
      expiresIn(10_000)
    )
    expect(backend.counts()).toEqual({ keys: 1, sessions: 1 })
    expect(
      backend.requests.some(function destroyed(request) {
        return new URL(request.url).pathname.startsWith("/v1/session/destroy/")
      })
    ).toBe(false)
    backend.reset()
  })

  test("replaces TTL owners safely and releases them when writing persistent data", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    await store.write(background(), { key: "replace", value: Uint8Array.of(1) }, expiresIn(10_000))
    await store.write(background(), { key: "replace", value: Uint8Array.of(2) }, expiresIn(10_000))
    expect(backend.counts()).toEqual({ keys: 1, sessions: 1 })
    const persistent = await store.write(background(), {
      key: "replace",
      value: Uint8Array.of(3)
    })
    expect(persistent.expiresAt).toBeNull()
    expect(backend.counts()).toEqual({ keys: 1, sessions: 0 })
    backend.reset()
  })

  test("fails closed for Consul's real cas+acquire conflict and CAS against a TTL owner", async () => {
    const backend = fakeConsul()
    const store = newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    const persistent = await store.write(background(), {
      key: "persistent",
      value: Uint8Array.of(1)
    })
    const beforeCombination = backend.requests.length
    await expect(
      store.write(
        background(),
        { key: "persistent", value: Uint8Array.of(2) },
        expiresIn(10_000),
        ifRevision(persistent.revision)
      )
    ).rejects.toMatchObject({
      code: "GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION",
      combination: "ttl-cas"
    })
    await expect(
      store.write(
        background(),
        { key: "absent-ttl", value: Uint8Array.of(2) },
        expiresIn(10_000),
        ifAbsent()
      )
    ).rejects.toMatchObject({
      code: "GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION",
      combination: "ttl-cas"
    })
    expect(backend.requests).toHaveLength(beforeCombination)

    const ttl = await store.write(
      background(),
      { key: "ttl-cas", value: Uint8Array.of(1) },
      expiresIn(10_000)
    )
    const beforeExisting = backend.requests.length
    await expect(
      store.write(
        background(),
        { key: "ttl-cas", value: Uint8Array.of(2) },
        ifRevision(ttl.revision)
      )
    ).rejects.toMatchObject({
      code: "GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION",
      combination: "cas-existing-ttl"
    })
    expect(backend.requests).toHaveLength(beforeExisting + 1)
    expect(backend.counts()).toEqual({ keys: 2, sessions: 1 })
    await store.delete(background(), "persistent")
    await store.delete(background(), "ttl-cas")
    backend.reset()
  })
})

describe("Consul Store uncertain-response readback", () => {
  test("proves lost KV write/delete and Session create/destroy responses", async () => {
    const backend = fakeConsul()
    const lost = new Set(["write", "delete", "session-create", "session-destroy"])
    /** Applies the real fake mutation, then drops its first matching response. */
    const fetch: ConsulFetch = async function lostResponse(request): Promise<Response> {
      const response = await backend.fetch(request)
      const url = new URL(request.url)
      let kind: string | null = null
      if (request.method === "PUT" && url.pathname === "/v1/session/create") kind = "session-create"
      else if (request.method === "PUT" && url.pathname.startsWith("/v1/session/destroy/"))
        kind = "session-destroy"
      else if (request.method === "PUT" && url.pathname.startsWith("/v1/kv/")) kind = "write"
      else if (request.method === "DELETE" && url.pathname.startsWith("/v1/kv/")) kind = "delete"
      if (kind !== null && lost.delete(kind)) throw new Error(`${kind} response lost`)
      return response
    }
    const store = newConsulStore({ fetch, address: "http://consul.test" })
    const persistent = await store.write(background(), {
      key: "lost-write",
      value: Uint8Array.of(1)
    })
    expect(persistent.revision).toMatch(/^\d+$/)
    expect(await store.delete(background(), "lost-write")).toBe(true)
    const ttl = await store.write(
      background(),
      { key: "lost-session", value: Uint8Array.of(2) },
      expiresIn(10_000)
    )
    expect(ttl.expiresAt).not.toBeNull()
    expect(await store.delete(background(), "lost-session")).toBe(true)
    expect(lost.size).toBe(0)
    expect(backend.counts()).toEqual({ keys: 0, sessions: 0 })
    backend.reset()
  })

  test("returns stable uncertainty when exact KV readback cannot prove a lost write", async () => {
    let requests = 0
    const store = newConsulStore({
      /** Serves readback while losing the mutation response before application. */
      async fetch(request): Promise<Response> {
        requests += 1
        if (request.method === "PUT") throw new Error("response lost")
        return new Response(null, { status: 404 })
      },
      address: "http://consul.test"
    })
    await expect(
      store.write(background(), { key: "unproven", value: Uint8Array.of(1) })
    ).rejects.toMatchObject({ code: "GO_LIKE_CONSUL_STORE_UNCERTAIN", operation: "write" })
    expect(requests).toBe(3)
  })

  test("returns stable uncertainty when lost write/delete readback also fails", async () => {
    let writeStage = 0
    const write = newConsulStore({
      /** Loses a write response and then makes its exact readback unavailable. */
      async fetch(request): Promise<Response> {
        if (request.method === "PUT") {
          writeStage += 1
          throw new Error("write response lost")
        }
        if (writeStage === 1) throw new Error("write readback unavailable")
        return new Response(null, { status: 404 })
      },
      address: "http://consul.test"
    })
    await expect(
      write.write(background(), { key: "unavailable", value: Uint8Array.of(1) })
    ).rejects.toMatchObject({ code: "GO_LIKE_CONSUL_STORE_UNCERTAIN", operation: "write" })

    const backend = fakeConsul()
    let deleteLost = false
    /** Applies delete then loses both its response and exact readback. */
    const deleteFetch: ConsulFetch = async function loseDelete(request): Promise<Response> {
      if (deleteLost && request.method === "GET") throw new Error("delete readback unavailable")
      const response = await backend.fetch(request)
      if (request.method === "DELETE") {
        deleteLost = true
        throw new Error("delete response lost")
      }
      return response
    }
    const deleting = newConsulStore({ fetch: deleteFetch, address: "http://consul.test" })
    await deleting.write(background(), { key: "delete-unavailable", value: Uint8Array.of(1) })
    await expect(deleting.delete(background(), "delete-unavailable")).rejects.toMatchObject({
      code: "GO_LIKE_CONSUL_STORE_UNCERTAIN",
      operation: "delete"
    })
    backend.reset()
  })

  test("cleans a new TTL session after definitive writes are rejected", async () => {
    const persistentFalse = [new Response(null, { status: 404 }), new Response("false")]
    const persistent = newConsulStore({
      /** Definitively rejects the plain KV mutation. */
      async fetch(): Promise<Response> {
        const response = persistentFalse.shift()
        if (response === undefined) throw new Error("unexpected request")
        return response
      },
      address: "http://consul.test"
    })
    await expect(
      persistent.write(background(), { key: "plain-false", value: Uint8Array.of(1) })
    ).rejects.toMatchObject({ code: "GO_LIKE_CONSUL_STORE_UNCERTAIN" })

    const ttlFalse = [
      new Response(null, { status: 404 }),
      Response.json({ ID: "session-ttl-false" }),
      new Response("false"),
      new Response("true")
    ]
    const ttl = newConsulStore({
      /** Rejects acquire and then accepts exact Session cleanup. */
      async fetch(): Promise<Response> {
        const response = ttlFalse.shift()
        if (response === undefined) throw new Error("unexpected request")
        return response
      },
      address: "http://consul.test"
    })
    await expect(
      ttl.write(background(), { key: "ttl-false", value: Uint8Array.of(1) }, expiresIn(10_000))
    ).rejects.toMatchObject({ code: "GO_LIKE_CONSUL_STORE_UNCERTAIN" })

    const ttlDenied = [
      new Response(null, { status: 404 }),
      Response.json({ ID: "session-ttl-denied" }),
      new Response("bad request", { status: 400 }),
      new Response("true")
    ]
    const denied = newConsulStore({
      /** Rejects acquire definitively and accepts exact Session cleanup. */
      async fetch(): Promise<Response> {
        const response = ttlDenied.shift()
        if (response === undefined) throw new Error("unexpected request")
        return response
      },
      address: "http://consul.test"
    })
    await expect(
      denied.write(background(), { key: "ttl-denied", value: Uint8Array.of(1) }, expiresIn(10_000))
    ).rejects.toMatchObject({ code: "GO_LIKE_CONSUL_STORE_HTTP", status: 400 })
  })

  test("aggregates primary TTL write and newly created session cleanup failures", async () => {
    const responses = [
      new Response(null, { status: 404 }),
      Response.json({ ID: "session-1" }),
      new Response("bad request", { status: 400 }),
      new Response("cleanup denied", { status: 400 })
    ]
    const store = newConsulStore({
      /** Serves one deterministic primary failure followed by cleanup failure. */
      async fetch(): Promise<Response> {
        const response = responses.shift()
        if (response === undefined) throw new Error("unexpected request")
        return response
      },
      address: "http://consul.test"
    })
    try {
      await store.write(
        background(),
        { key: "aggregate", value: Uint8Array.of(1) },
        expiresIn(10_000)
      )
      throw new Error("write unexpectedly succeeded")
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      if (!(error instanceof AggregateError)) throw error
      expect(error.errors).toHaveLength(2)
    }
  })

  test("handles definite CAS losses, unconditional delete races, and expired carrier cleanup", async () => {
    const backend = fakeConsul()
    let rejectCas = false
    let rejectDelete = false
    /** Injects definite false mutations without changing the shared fake backend. */
    const fetch: ConsulFetch = async function race(request): Promise<Response> {
      const url = new URL(request.url)
      if (rejectCas && request.method === "PUT" && url.searchParams.has("cas")) {
        rejectCas = false
        return new Response("false")
      }
      if (rejectDelete && request.method === "DELETE") {
        rejectDelete = false
        return new Response("false")
      }
      return backend.fetch(request)
    }
    const store = newConsulStore({ fetch, address: "http://consul.test" })
    const current = await store.write(background(), { key: "race", value: Uint8Array.of(1) })
    rejectCas = true
    await expect(
      store.write(
        background(),
        { key: "race", value: Uint8Array.of(2) },
        ifRevision(current.revision)
      )
    ).rejects.toMatchObject({ code: "GO_LIKE_STORE_CONFLICT", actualRevision: current.revision })
    rejectDelete = true
    expect(await store.delete(background(), "race")).toBe(false)
    rejectDelete = true
    await expect(
      store.delete(background(), "race", ifRevision(current.revision))
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      actualRevision: current.revision
    })
    await store.delete(background(), "race")
    backend.reset()

    const scripted = [
      Response.json([expiredRow("expired", 77, null)]),
      new Response("true"),
      Response.json([expiredRow("expired-cas", 78, null)]),
      new Response("true"),
      Response.json([expiredRow("expired-if-absent", 79, null)]),
      new Response("false"),
      Response.json([activeRow("expired-if-absent", 80)])
    ]
    const expiring = newConsulStore({
      /** Serves expired provider carriers that have not yet been reaped remotely. */
      async fetch(): Promise<Response> {
        const response = scripted.shift()
        if (response === undefined) throw new Error("unexpected request")
        return response
      },
      address: "http://consul.test"
    })
    expect(await expiring.delete(background(), "expired")).toBe(false)
    await expect(
      expiring.delete(background(), "expired-cas", ifRevision("78"))
    ).rejects.toMatchObject({ code: "GO_LIKE_STORE_CONFLICT", actualRevision: null })
    await expect(
      expiring.write(
        background(),
        { key: "expired-if-absent", value: Uint8Array.of(3) },
        ifAbsent()
      )
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      expectedRevision: null,
      actualRevision: "80"
    })

    const disappearingBackend = fakeConsul()
    const key = "expired-disappeared"
    await disappearingBackend.fetch(
      new Request(`http://consul.test/v1/kv/go-like/store/${key}`, {
        method: "PUT",
        body: encodeRecordPayload(
          { key, value: Uint8Array.of(1), metadata: {} },
          "expired-operation",
          Date.now() - 1
        )
      })
    )
    let disappeared = false
    const disappearing = newConsulStore({
      /** Simulates a behavior-delete Session expiring immediately before exact cleanup. */
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        if (!disappeared && request.method === "DELETE" && url.searchParams.has("cas")) {
          disappeared = true
          url.search = ""
          await disappearingBackend.fetch(new Request(url, { method: "DELETE" }))
          return new Response("false")
        }
        return disappearingBackend.fetch(request)
      },
      address: "http://consul.test"
    })
    expect(
      Array.from(
        (await disappearing.write(background(), { key, value: Uint8Array.of(4) }, ifAbsent())).value
      )
    ).toEqual([4])
    disappearingBackend.reset()
  })
})
