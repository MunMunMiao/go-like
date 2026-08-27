import { background } from "@go-like/context"
import { cursor, expiresIn, ifRevision, limit, prefix } from "@go-like/store"
import { describe, expect, test } from "bun:test"

import { encodeRecordPayload, encodeText } from "../src/codec"
import { newEtcdStore } from "../src/index"
import type { EtcdStore, EtcdStoreFetch } from "../src/types"
import { fakeEtcd } from "./helpers"

/** Creates one immediately usable Store around a selected borrowed Fetch. */
function subject(fetch: EtcdStoreFetch): EtcdStore {
  return newEtcdStore({ fetch, address: "http://etcd.test" })
}

/** Creates one JSON gateway response. */
function json(value: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

/** Reads one request JSON carrier without retaining its mutable object. */
async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.clone().json()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test request body was invalid")
  }
  return Object.fromEntries(Object.entries(value))
}

/** Reads one own JSON data property. */
function property(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Executes one request directly against the fake gateway. */
async function raw(
  fetch: EtcdStoreFetch,
  path: string,
  body: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const response = await fetch(
    new Request(`http://etcd.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  )
  const value: unknown = await response.json()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fake gateway returned invalid JSON")
  }
  return Object.fromEntries(Object.entries(value))
}

/** Seeds one physically leased row whose go-like visibility already expired. */
async function seedExpired(fetch: EtcdStoreFetch, key: string): Promise<string> {
  const granted = await raw(fetch, "/v3/lease/grant", { TTL: "100" })
  const lease = property(granted, "ID")
  if (typeof lease !== "string") throw new Error("fake lease grant omitted ID")
  const payload = encodeRecordPayload(
    { key, value: new Uint8Array([1]) },
    "expired-operation",
    Date.now() - 1
  )
  await raw(fetch, "/v3/kv/txn", {
    compare: [{ target: "VERSION", result: "EQUAL", key: encodeText(key), version: "0" }],
    success: [
      {
        request_put: {
          key: encodeText(key),
          value: encodeText(payload),
          lease,
          prev_kv: true
        }
      }
    ],
    failure: [{ request_range: { key: encodeText(key) } }]
  })
  return lease
}

/** Reads one Store error code without using a type assertion. */
function errorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "code" in value ? value.code : null
}

describe("Store declared boundaries", () => {
  test("rejects TTL, pagination, and missing-key CAS outside provider bounds", async () => {
    const backend = fakeEtcd()
    const value = subject(backend.fetch)
    await expect(
      value.write(background(), { key: "bounds/short", value: new Uint8Array() }, expiresIn(999))
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      value.write(
        background(),
        { key: "bounds/long", value: new Uint8Array() },
        expiresIn(2_147_483_648)
      )
    ).rejects.toBeInstanceOf(RangeError)
    await expect(value.list(background(), limit(1_001))).rejects.toBeInstanceOf(RangeError)
    await expect(
      value.delete(background(), "bounds/missing", ifRevision("1"))
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      actualRevision: null
    })
  })
})

describe("lease cleanup", () => {
  test("proactively revokes a deleted TTL record and accepts an already-missing lease", async () => {
    const backend = fakeEtcd()
    const value = subject(backend.fetch)
    await value.write(
      background(),
      { key: "lease/delete", value: new Uint8Array([1]) },
      expiresIn(10_000)
    )
    expect(backend.leaseCount()).toBe(1)
    expect(await value.delete(background(), "lease/delete")).toBeTrue()
    expect(backend.leaseCount()).toBe(0)

    const missingBackend = fakeEtcd()
    const missing = subject(async (request) => {
      if (new URL(request.url).pathname === "/v3/lease/revoke") {
        return json({ code: 5, message: "missing" }, 404)
      }
      return await missingBackend.fetch(request)
    })
    await missing.write(
      background(),
      { key: "lease/missing", value: new Uint8Array([1]) },
      expiresIn(10_000)
    )
    expect(await missing.delete(background(), "lease/missing")).toBeTrue()
    missingBackend.reset()
  })

  test("reports committed delete cleanup failure without restoring the key", async () => {
    const backend = fakeEtcd()
    let rejectRevoke = false
    const value = subject(async (request) => {
      if (rejectRevoke && new URL(request.url).pathname === "/v3/lease/revoke") {
        return json({ code: 14, message: "unavailable" }, 503)
      }
      return await backend.fetch(request)
    })
    await value.write(
      background(),
      { key: "lease/cleanup", value: new Uint8Array([1]) },
      expiresIn(10_000)
    )
    rejectRevoke = true
    await expect(value.delete(background(), "lease/cleanup")).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_STORE_CLEANUP",
      operation: "delete",
      committed: true
    })
    rejectRevoke = false
    expect(await value.read(background(), "lease/cleanup")).toBeNull()
    backend.reset()
  })
})

describe("write races and uncertainty", () => {
  test("cleans a granted TTL lease after a CAS race and retries unconditional races", async () => {
    const backend = fakeEtcd()
    const competitor = subject(backend.fetch)
    let race = false
    let raced = false
    const value = subject(async (request) => {
      if (race && !raced && new URL(request.url).pathname === "/v3/kv/txn") {
        raced = true
        await competitor.write(background(), {
          key: "race/write",
          value: new Uint8Array([2])
        })
      }
      return await backend.fetch(request)
    })
    const initial = await competitor.write(background(), {
      key: "race/write",
      value: new Uint8Array([1])
    })
    race = true
    await expect(
      value.write(
        background(),
        { key: "race/write", value: new Uint8Array([3]) },
        ifRevision(initial.revision),
        expiresIn(10_000)
      )
    ).rejects.toMatchObject({ code: "GO_LIKE_STORE_CONFLICT" })
    expect(backend.leaseCount()).toBe(0)

    race = true
    raced = false
    const written = await value.write(background(), {
      key: "race/write",
      value: new Uint8Array([4])
    })
    expect(written.value).toEqual(new Uint8Array([4]))
    await competitor.delete(background(), "race/write")
  })

  test("cleans deterministic TTL failures and preserves ordered cleanup failure", async () => {
    const backend = fakeEtcd()
    let rejectCleanup = false
    const value = subject(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/v3/kv/txn") return json({ code: 3, message: "invalid" }, 400)
      if (rejectCleanup && path === "/v3/lease/revoke") {
        return json({ code: 14, message: "unavailable" }, 503)
      }
      return await backend.fetch(request)
    })
    await expect(
      value.write(
        background(),
        { key: "write/deterministic", value: new Uint8Array() },
        expiresIn(10_000)
      )
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_STORE_HTTP", status: 400 })
    expect(backend.leaseCount()).toBe(0)
    rejectCleanup = true
    const aggregate = await value
      .write(background(), { key: "write/aggregate", value: new Uint8Array() }, expiresIn(10_000))
      .catch((error: unknown) => error)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect(Object.isFrozen(aggregate)).toBeTrue()
    rejectCleanup = false
    backend.reset()
  })

  test("maps a revoked grant to lease-lost before any write commit", async () => {
    const backend = fakeEtcd()
    let lease = ""
    const value = subject(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/v3/lease/grant") {
        const response = await backend.fetch(request)
        const body: unknown = await response.clone().json()
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const id = Object.getOwnPropertyDescriptor(body, "ID")?.value
          if (typeof id === "string") lease = id
        }
        return response
      }
      if (path === "/v3/kv/txn" && lease !== "") {
        await raw(backend.fetch, "/v3/lease/revoke", { ID: lease })
      }
      return await backend.fetch(request)
    })
    await expect(
      value.write(
        background(),
        { key: "write/lease-lost", value: new Uint8Array() },
        expiresIn(10_000)
      )
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_STORE_LEASE_LOST" })
    expect(backend.size()).toBe(0)
    expect(backend.leaseCount()).toBe(0)
  })

  test("accepts committed readback and rejects absent or unavailable readback", async () => {
    const committedBackend = fakeEtcd()
    let loseCommittedResponse = true
    const committed = subject(async (request) => {
      if (loseCommittedResponse && new URL(request.url).pathname === "/v3/kv/txn") {
        loseCommittedResponse = false
        await committedBackend.fetch(request)
        throw new Error("response lost")
      }
      return await committedBackend.fetch(request)
    })
    const written = await committed.write(background(), {
      key: "uncertain/committed",
      value: new Uint8Array([1])
    })
    expect(written.revision).not.toBe("")
    await committed.delete(background(), "uncertain/committed")

    const absentBackend = fakeEtcd()
    let loseAbsentResponse = true
    const absent = subject(async (request) => {
      if (loseAbsentResponse && new URL(request.url).pathname === "/v3/kv/txn") {
        loseAbsentResponse = false
        throw new Error("request lost")
      }
      return await absentBackend.fetch(request)
    })
    await expect(
      absent.write(background(), {
        key: "uncertain/absent",
        value: new Uint8Array([1])
      })
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_STORE_UNCERTAIN" })

    const unreadableBackend = fakeEtcd()
    let rangeCalls = 0
    const unreadable = subject(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/v3/kv/range") rangeCalls += 1
      if (path === "/v3/kv/txn") throw new Error("request lost")
      if (path === "/v3/kv/range" && rangeCalls >= 2) throw new Error("readback lost")
      return await unreadableBackend.fetch(request)
    })
    await expect(
      unreadable.write(background(), {
        key: "uncertain/unreadable",
        value: new Uint8Array([1])
      })
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_STORE_UNCERTAIN" })
  })

  test("cleans detached uncertain TTL leases and reports cleanup uncertainty", async () => {
    for (const cleanupFails of [false, true]) {
      const backend = fakeEtcd()
      let lose = true
      const value = subject(async (request) => {
        const path = new URL(request.url).pathname
        if (lose && path === "/v3/kv/txn") {
          lose = false
          throw new Error("request lost")
        }
        if (cleanupFails && path === "/v3/lease/revoke") {
          return json({ code: 14, message: "unavailable" }, 503)
        }
        return await backend.fetch(request)
      })
      const error = await value
        .write(
          background(),
          { key: `uncertain/ttl/${cleanupFails}`, value: new Uint8Array() },
          expiresIn(10_000)
        )
        .catch((reason: unknown) => reason)
      expect(errorCode(error)).toBe("GO_LIKE_ETCD_STORE_UNCERTAIN")
      expect(backend.leaseCount()).toBe(cleanupFails ? 1 : 0)
      backend.reset()
    }
  })
})

describe("delete races and uncertainty", () => {
  test("accepts committed readback and retries the unchanged generation", async () => {
    const committedBackend = fakeEtcd()
    let loseAfterCommit = false
    const committed = subject(async (request) => {
      if (loseAfterCommit && new URL(request.url).pathname === "/v3/kv/txn") {
        loseAfterCommit = false
        await committedBackend.fetch(request)
        throw new Error("response lost")
      }
      return await committedBackend.fetch(request)
    })
    await committed.write(background(), {
      key: "delete/committed",
      value: new Uint8Array([1])
    })
    loseAfterCommit = true
    expect(await committed.delete(background(), "delete/committed")).toBeTrue()

    const retryBackend = fakeEtcd()
    let loseBeforeCommit = false
    const retry = subject(async (request) => {
      if (loseBeforeCommit && new URL(request.url).pathname === "/v3/kv/txn") {
        loseBeforeCommit = false
        throw new Error("request lost")
      }
      return await retryBackend.fetch(request)
    })
    await retry.write(background(), {
      key: "delete/retry",
      value: new Uint8Array([1])
    })
    loseBeforeCommit = true
    expect(await retry.delete(background(), "delete/retry")).toBeTrue()
  })

  test("rejects failed or foreign delete readback without touching replacement state", async () => {
    const unreadableBackend = fakeEtcd()
    let armed = false
    let rangeCalls = 0
    const unreadable = subject(async (request) => {
      const path = new URL(request.url).pathname
      if (armed && path === "/v3/kv/range") rangeCalls += 1
      if (armed && path === "/v3/kv/txn") throw new Error("request lost")
      if (armed && path === "/v3/kv/range" && rangeCalls >= 2) {
        throw new Error("readback lost")
      }
      return await unreadableBackend.fetch(request)
    })
    await unreadable.write(background(), {
      key: "delete/unreadable",
      value: new Uint8Array([1])
    })
    armed = true
    await expect(unreadable.delete(background(), "delete/unreadable")).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_STORE_UNCERTAIN"
    })
    armed = false
    await unreadable.delete(background(), "delete/unreadable")

    const foreignBackend = fakeEtcd()
    const competitor = subject(foreignBackend.fetch)
    let replace = false
    const foreign = subject(async (request) => {
      if (replace && new URL(request.url).pathname === "/v3/kv/txn") {
        replace = false
        await competitor.write(background(), {
          key: "delete/foreign",
          value: new Uint8Array([2])
        })
        throw new Error("request lost")
      }
      return await foreignBackend.fetch(request)
    })
    await foreign.write(background(), {
      key: "delete/foreign",
      value: new Uint8Array([1])
    })
    replace = true
    await expect(foreign.delete(background(), "delete/foreign")).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_STORE_UNCERTAIN"
    })
    expect((await competitor.read(background(), "delete/foreign"))?.value).toEqual(
      new Uint8Array([2])
    )
    await competitor.delete(background(), "delete/foreign")
  })

  test("turns deterministic replacement into CAS conflict and retries unconditional delete", async () => {
    for (const conditional of [true, false]) {
      const backend = fakeEtcd()
      const competitor = subject(backend.fetch)
      let race = false
      const value = subject(async (request) => {
        if (race && new URL(request.url).pathname === "/v3/kv/txn") {
          race = false
          await competitor.write(background(), {
            key: `delete/race/${conditional}`,
            value: new Uint8Array([2])
          })
        }
        return await backend.fetch(request)
      })
      const initial = await value.write(background(), {
        key: `delete/race/${conditional}`,
        value: new Uint8Array([1])
      })
      race = true
      if (conditional) {
        await expect(
          value.delete(background(), `delete/race/${conditional}`, ifRevision(initial.revision))
        ).rejects.toMatchObject({ code: "GO_LIKE_STORE_CONFLICT" })
        await competitor.delete(background(), `delete/race/${conditional}`)
      } else {
        expect(await value.delete(background(), `delete/race/${conditional}`)).toBeTrue()
      }
    }
  })

  test("physically cleans expired CAS rows and does not delete a racing replacement", async () => {
    const backend = fakeEtcd()
    const value = subject(backend.fetch)
    await seedExpired(backend.fetch, "delete/expired-cas")
    await expect(
      value.delete(background(), "delete/expired-cas", ifRevision("stale"))
    ).rejects.toMatchObject({
      code: "GO_LIKE_STORE_CONFLICT",
      actualRevision: null
    })
    expect(backend.size()).toBe(0)
    expect(backend.leaseCount()).toBe(0)

    const raceBackend = fakeEtcd()
    const competitor = subject(raceBackend.fetch)
    let race = false
    const racing = subject(async (request) => {
      if (race && new URL(request.url).pathname === "/v3/kv/txn") {
        race = false
        await competitor.write(background(), {
          key: "delete/expired-race",
          value: new Uint8Array([2])
        })
      }
      return await raceBackend.fetch(request)
    })
    await seedExpired(raceBackend.fetch, "delete/expired-race")
    race = true
    expect(await racing.delete(background(), "delete/expired-race")).toBeFalse()
    expect((await competitor.read(background(), "delete/expired-race"))?.value).toEqual(
      new Uint8Array([2])
    )
    await competitor.delete(background(), "delete/expired-race")
  })
})

describe("stable pagination failures", () => {
  test("maps compacted cursors and preserves unrelated list protocol failures", async () => {
    const backend = fakeEtcd()
    let compact = false
    const value = subject(async (request) => {
      if (compact && new URL(request.url).pathname === "/v3/kv/range") {
        const body = await requestBody(request)
        if (typeof property(body, "revision") === "string") {
          return json({ code: 11, message: "compacted" }, 400)
        }
      }
      return await backend.fetch(request)
    })
    for (const key of ["page/a", "page/b"]) {
      await value.write(background(), { key, value: new Uint8Array([1]) })
    }
    const first = await value.list(background(), prefix("page/"), limit(1))
    if (first.cursor === null) throw new Error("pagination fixture omitted cursor")
    compact = true
    await expect(
      value.list(background(), prefix("page/"), limit(1), cursor(first.cursor))
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_STORE_COMPACTED" })
    compact = false
    for (const key of ["page/a", "page/b"]) await value.delete(background(), key)

    const malformedBackend = fakeEtcd()
    let malformed = false
    const malformedStore = subject(async (request) => {
      if (malformed && new URL(request.url).pathname === "/v3/kv/range") {
        const body = await requestBody(request)
        if (property(body, "range_end") !== undefined)
          return json({ header: { revision: "1" }, more: "yes" })
      }
      return await malformedBackend.fetch(request)
    })
    malformed = true
    await expect(malformedStore.list(background())).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_STORE_PROTOCOL"
    })
  })

  test("rejects an impossible zero-revision continuation page", async () => {
    const backend = fakeEtcd()
    let inject = false
    const key = "zero/key"
    const payload = encodeRecordPayload({ key, value: new Uint8Array([1]) }, "zero-operation", null)
    const value = subject(async (request) => {
      if (inject && new URL(request.url).pathname === "/v3/kv/range") {
        const body = await requestBody(request)
        if (property(body, "range_end") !== undefined) {
          return json({
            header: { revision: "0" },
            kvs: [
              {
                key: encodeText(key),
                value: encodeText(payload),
                mod_revision: "1",
                lease: "0"
              }
            ],
            more: true
          })
        }
      }
      return await backend.fetch(request)
    })
    inject = true
    await expect(value.list(background(), limit(1))).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_STORE_PROTOCOL"
    })
  })
})
