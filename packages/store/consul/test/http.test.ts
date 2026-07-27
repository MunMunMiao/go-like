import { describe, expect, test } from "bun:test"

import { background, withCancelCause, type Context, type ContextError } from "@likego/context"

import { encodeBase64, encodeRecordPayload } from "../src/codec"
import {
  consulUrl,
  createSession,
  destroySession,
  encodedKey,
  ignoreFailure,
  mutateKey,
  queryExact,
  queryIndexedRows,
  queryRows
} from "../src/http"
import { captureOptions, type CapturedOptions } from "../src/options"
import type { ConsulFetch } from "../src/types"

/** Creates captured provider options around one exact borrowed Fetch. */
function options(fetch: ConsulFetch, token?: string): CapturedOptions {
  const base = {
    fetch,
    address: "http://consul.test:8500",
    datacenter: "dc-west",
    namespace: "payments"
  }
  return token === undefined ? captureOptions(base) : captureOptions(Object.assign(base, { token }))
}

/** Creates one real Consul row containing a valid LikeGo payload. */
function row(key = "orders/one", index = 42): object {
  const payload = encodeRecordPayload(
    { key, value: Uint8Array.of(1), metadata: { owner: "orders" } },
    "operation-1",
    null
  )
  return {
    Key: `likego/store/${key}`,
    ModifyIndex: index,
    Value: encodeBase64(new TextEncoder().encode(payload)),
    Session: null
  }
}

/** Creates one queue-backed Fetch and records every standard Request. */
function scripted(values: Array<Response | Error | null>): {
  readonly fetch: ConsulFetch
  readonly requests: readonly Request[]
} {
  const requests: Request[] = []
  return Object.freeze({
    requests,
    /** Returns or throws the next exact scripted transport result. */
    async fetch(request: Request): Promise<Response> {
      requests.push(request)
      const value = values.shift()
      if (value instanceof Error) throw value
      return value as never
    }
  })
}

describe("Consul Store HTTP boundary", () => {
  test("encodes keys without dot-segment normalization and scopes URLs without secrets", () => {
    expect(encodedKey("services/订单 one")).toBe("services/%E8%AE%A2%E5%8D%95%20one")
    expect(encodedKey("/leading//trailing/")).toBe("/leading//trailing/")
    expect(() => encodedKey("a/./b")).toThrow("dot path segment")
    expect(() => encodedKey("a/../b")).toThrow("dot path segment")

    const captured = options(async () => new Response(null), "top-secret")
    const url = consulUrl(captured, "/v1/kv/orders")
    expect(url.origin).toBe("http://consul.test:8500")
    expect(url.searchParams.get("dc")).toBe("dc-west")
    expect(url.searchParams.get("ns")).toBe("payments")
    expect(url.href).not.toContain("top-secret")
  })

  test("issues strong exact and recursive queries with secret-safe standard Requests", async () => {
    const script = scripted([
      Response.json([row()]),
      new Response(null, { status: 404 }),
      Response.json([row("orders/a"), row("orders/b", 43)])
    ])
    const captured = options(script.fetch, "top-secret")

    expect((await queryExact(background(), captured, "read", "orders/one"))?.record.revision).toBe(
      "42"
    )
    expect(await queryExact(background(), captured, "read", "missing")).toBeNull()
    expect(await queryRows(background(), captured, "list", "orders/", true)).toHaveLength(2)

    const exact = script.requests[0]
    const recurse = script.requests[2]
    if (exact === undefined || recurse === undefined) throw new Error("request missing")
    expect(exact.method).toBe("GET")
    expect(exact.redirect).toBe("error")
    expect(exact.headers.get("X-Consul-Token")).toBe("top-secret")
    expect(exact.url).not.toContain("top-secret")
    expect(new URL(exact.url).searchParams.has("consistent")).toBe(true)
    expect(new URL(exact.url).pathname).toBe("/v1/kv/likego/store/orders/one")
    expect(new URL(recurse.url).searchParams.get("recurse")).toBe("true")
    expect(new URL(recurse.url).pathname).toBe("/v1/kv/likego/store/orders/")
  })

  test("rejects ambiguous exact rows, non-success status, malformed bodies, and non-Responses", async () => {
    const cases: Array<{ readonly response: Response | null; readonly code: string }> = [
      { response: Response.json([row("wrong")]), code: "LIKEGO_CONSUL_STORE_PROTOCOL" },
      { response: Response.json([row(), row("orders/two")]), code: "LIKEGO_CONSUL_STORE_PROTOCOL" },
      { response: new Response("secret body", { status: 403 }), code: "LIKEGO_CONSUL_STORE_HTTP" },
      { response: new Response("not json"), code: "LIKEGO_CONSUL_STORE_PROTOCOL" },
      { response: null, code: "LIKEGO_CONSUL_STORE_PROTOCOL" }
    ]
    for (const item of cases) {
      const script = scripted([item.response])
      try {
        await queryExact(background(), options(script.fetch), "read", "orders/one")
        throw new Error("invalid query unexpectedly succeeded")
      } catch (error) {
        expect(error).toMatchObject({ code: item.code })
        expect(String(error)).not.toContain("secret body")
      }
    }
  })

  test("requires a valid Consul index for stable recursive pagination", async () => {
    for (const response of [
      Response.json([row()]),
      Response.json([row()], { headers: { "X-Consul-Index": "0" } })
    ]) {
      const script = scripted([response])
      await expect(
        queryIndexedRows(background(), options(script.fetch), "orders/")
      ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_PROTOCOL" })
    }
    const script = scripted([Response.json([row()], { headers: { "X-Consul-Index": "42" } })])
    await expect(queryIndexedRows(background(), options(script.fetch), "orders/")).resolves.toEqual(
      {
        rows: expect.any(Array),
        index: "42"
      }
    )
  })

  test("normalizes synchronous, asynchronous, body, and cancellation transport failures", async () => {
    const synchronous: ConsulFetch = function throwSynchronously(): Promise<Response> {
      throw new Error("sync refused")
    }
    await expect(
      queryRows(background(), options(synchronous), "read", "x", false)
    ).rejects.toMatchObject({
      code: "LIKEGO_CONSUL_STORE_TRANSPORT"
    })

    const asynchronous = scripted([new Error("async refused")])
    await expect(
      queryRows(background(), options(asynchronous.fetch), "read", "x", false)
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_TRANSPORT" })

    const brokenBody = new ReadableStream<Uint8Array>({
      /** Rejects the response body at its first pull. */
      start(controller): void {
        controller.error(new Error("body rejected"))
      }
    })
    const bodyScript = scripted([new Response(brokenBody)])
    await expect(
      queryRows(background(), options(bodyScript.fetch), "read", "x", false)
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_PROTOCOL" })

    const syncText = new Response("[]")
    Object.defineProperty(syncText, "text", {
      /** Simulates a standard host throwing before returning its body Promise. */
      value(): never {
        throw new Error("text failed synchronously")
      }
    })
    const textScript = scripted([syncText])
    await expect(
      queryRows(background(), options(textScript.fetch), "read", "x", false)
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_PROTOCOL" })

    const [preCanceled, cancelPre] = withCancelCause(background())
    const preReason = new Error("pre-canceled")
    cancelPre(preReason)
    let called = false
    await expect(
      queryRows(
        preCanceled,
        options(async () => {
          called = true
          return Response.json([])
        }),
        "read",
        "x",
        false
      )
    ).rejects.toBe(preReason)
    expect(called).toBe(false)

    const [lateCanceled, cancelLate] = withCancelCause(background())
    const lateReason = new Error("late-canceled")
    const late = options(async () => {
      cancelLate(lateReason)
      return new Response("[]")
    })
    await expect(queryRows(lateCanceled, late, "read", "x", false)).rejects.toBe(lateReason)

    const cancelThrows = new Response("denied", { status: 403 })
    if (cancelThrows.body === null) throw new Error("test response body missing")
    Object.defineProperty(cancelThrows.body, "cancel", {
      value(): never {
        throw new Error("cancel failed synchronously")
      }
    })
    await expect(
      queryRows(
        background(),
        options(async () => cancelThrows),
        "read",
        "x",
        false
      )
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_HTTP", status: 403 })

    let inspections = 0
    const observed = new Error("canceled after transport") as ContextError
    const afterTransport: Context = Object.freeze({
      /** Exposes no deadline. */
      deadline(): readonly [Date, boolean] {
        return Object.freeze([new Date(0), false])
      },
      /** Exposes no cancellation signal so the transport wins its wait. */
      done(): null {
        return null
      },
      /** Becomes terminal only at execute's post-transport inspection. */
      err(): ContextError | null {
        inspections += 1
        return inspections >= 3 ? observed : null
      },
      /** Carries no values. */
      value(): null {
        return null
      }
    })
    await expect(
      queryRows(
        afterTransport,
        options(async () => new Response("[]")),
        "read",
        "x",
        false
      )
    ).rejects.toBe(observed)
    ignoreFailure(new Error("observed cancellation"))
  })

  test("encodes plain, CAS, acquire, release, and delete mutation modes", async () => {
    const script = scripted([
      new Response("true"),
      new Response("false"),
      new Response("true"),
      new Response("true"),
      new Response("true")
    ])
    const captured = options(script.fetch)
    expect(await mutateKey(background(), captured, "write", "k", "one", { kind: "plain" })).toBe(
      true
    )
    expect(
      await mutateKey(background(), captured, "write", "k", "two", {
        kind: "cas",
        revision: "42"
      })
    ).toBe(false)
    expect(
      await mutateKey(background(), captured, "write", "k", "three", {
        kind: "acquire",
        session: "session-a"
      })
    ).toBe(true)
    expect(
      await mutateKey(background(), captured, "write", "k", "four", {
        kind: "release",
        session: "session-a"
      })
    ).toBe(true)
    expect(
      await mutateKey(background(), captured, "delete", "k", null, {
        kind: "cas",
        revision: "43"
      })
    ).toBe(true)

    const searches = script.requests.map((request) => new URL(request.url).search)
    expect(searches).toEqual([
      "?dc=dc-west&ns=payments",
      "?dc=dc-west&ns=payments&cas=42",
      "?dc=dc-west&ns=payments&acquire=session-a",
      "?dc=dc-west&ns=payments&release=session-a",
      "?dc=dc-west&ns=payments&cas=43"
    ])
    expect(script.requests.map((request) => request.method)).toEqual([
      "PUT",
      "PUT",
      "PUT",
      "PUT",
      "DELETE"
    ])
  })

  test("rejects invalid boolean mutation bodies and status without exposing bodies", async () => {
    const malformed = scripted([new Response("yes")])
    await expect(
      mutateKey(background(), options(malformed.fetch), "write", "k", "v", { kind: "plain" })
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_PROTOCOL" })

    const denied = scripted([new Response("ACL TOKEN top-secret", { status: 403 })])
    try {
      await mutateKey(background(), options(denied.fetch, "top-secret"), "write", "k", "v", {
        kind: "plain"
      })
      throw new Error("denied mutation unexpectedly succeeded")
    } catch (error) {
      expect(error).toMatchObject({ code: "LIKEGO_CONSUL_STORE_HTTP", status: 403 })
      expect(String(error)).not.toContain("top-secret")
    }
  })
})

describe("Consul Store behavior-delete sessions", () => {
  test("creates the exact TTL session shape and accepts a validated ID", async () => {
    const script = scripted([Response.json({ ID: "session-1" })])
    await expect(createSession(background(), options(script.fetch), "op-1", 10_001)).resolves.toBe(
      "session-1"
    )
    const request = script.requests[0]
    if (request === undefined) throw new Error("request missing")
    expect(request.method).toBe("PUT")
    expect(request.headers.get("Content-Type")).toBe("application/json")
    expect(await request.clone().json()).toEqual({
      Name: "likego-store:op-1",
      Behavior: "delete",
      TTL: "10001ms",
      LockDelay: "0s",
      NodeChecks: []
    })
  })

  test("proves a lost create response by unique session-name readback", async () => {
    const script = scripted([
      new Error("response lost"),
      Response.json([{ ID: "session-readback", Name: "likego-store:op-lost" }])
    ])
    await expect(
      createSession(background(), options(script.fetch), "op-lost", 10_000)
    ).resolves.toBe("session-readback")
    expect(new URL(script.requests[1]?.url ?? "http://missing").pathname).toBe("/v1/session/list")
  })

  test("fails closed when create/readback is malformed, ambiguous, denied, or unproven", async () => {
    const cases: Array<Array<Response | Error | null>> = [
      [new Response("not-json"), Response.json([])],
      [Response.json([]), Response.json([])],
      [Response.json({ ID: "" }), Response.json([])],
      [new Error("lost"), new Response("not-json")],
      [new Error("lost"), Response.json({})],
      [new Error("lost"), Response.json([null])],
      [new Error("lost"), Response.json([{ ID: 1, Name: "x" }])],
      [
        new Error("lost"),
        Response.json([
          { ID: "one", Name: "likego-store:duplicate" },
          { ID: "two", Name: "likego-store:duplicate" }
        ])
      ],
      [new Error("lost"), new Response("denied", { status: 403 })],
      [new Error("lost"), Response.json([])]
    ]
    for (let index = 0; index < cases.length; index += 1) {
      const script = scripted(cases[index] ?? [])
      await expect(
        createSession(
          background(),
          options(script.fetch),
          index === 7 ? "duplicate" : `invalid-${index}`,
          10_000
        )
      ).rejects.toBeInstanceOf(Error)
    }

    const definitive = scripted([new Response("bad request", { status: 400 })])
    await expect(
      createSession(background(), options(definitive.fetch), "bad", 10_000)
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_HTTP", status: 400 })
  })

  test("destroys a session and proves uncertain outcomes with exact info readback", async () => {
    const accepted = scripted([new Response("true")])
    await expect(
      destroySession(background(), options(accepted.fetch), "session-1")
    ).resolves.toBeUndefined()

    for (const initial of [new Response("false"), new Response("unexpected"), new Error("lost")]) {
      const absent = scripted([initial, Response.json([])])
      await expect(
        destroySession(background(), options(absent.fetch), "session-2")
      ).resolves.toBeUndefined()
    }

    const remains = scripted([
      new Error("lost"),
      Response.json([{ ID: "session-3", Name: "likego-store:op" }])
    ])
    await expect(
      destroySession(background(), options(remains.fetch), "session-3")
    ).rejects.toMatchObject({
      code: "LIKEGO_CONSUL_STORE_UNCERTAIN",
      operation: "session-destroy"
    })
  })

  test("rejects definitive destroy failures and malformed session info", async () => {
    const denied = scripted([new Response("denied", { status: 400 })])
    await expect(
      destroySession(background(), options(denied.fetch), "session-1")
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_STORE_HTTP", status: 400 })

    for (const info of [
      new Response("not-json"),
      Response.json({}),
      Response.json([null]),
      Response.json([{ ID: "", Name: "x" }]),
      new Response("denied", { status: 403 })
    ]) {
      const malformed = scripted([new Response("false"), info])
      await expect(
        destroySession(background(), options(malformed.fetch), "session-1")
      ).rejects.toBeInstanceOf(Error)
    }
  })
})
