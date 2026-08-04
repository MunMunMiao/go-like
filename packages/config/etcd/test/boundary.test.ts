import { describe, expect, test } from "bun:test"

import { background, withCancelCause } from "@go-like/context"

import { etcdSource, jsonEtcdDecoder, type EtcdFetch } from "../src/index"
import { deferred } from "./helpers"

/** Returns one minimal exact-key range response. */
function range(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** Returns one newline-delimited watch response. */
function watch(line: unknown, newline = true): Response {
  return new Response(`${JSON.stringify(line)}${newline ? "\n" : ""}`)
}

/** Creates one source around a controlled Fetch capability. */
function source(fetch: EtcdFetch) {
  return etcdSource({
    fetch,
    address: "http://etcd:2379",
    key: "app/config",
    retryInitialMs: 1,
    retryMaximumMs: 1
  })
}

/** Waits one event-loop turn so a blocked watcher reaches its retry interval. */
function turn(): Promise<void> {
  return new Promise<void>(function wait(resolve) {
    setTimeout(resolve, 5)
  })
}

describe("etcd configuration protocol boundaries", () => {
  test("admits the complete JSON value domain and rejects unsafe roots and members", () => {
    expect(
      jsonEtcdDecoder('{"array":[null,true,"text",1,{"nested":false}],"unicode":"配置"}', "key")
    ).toEqual({ array: [null, true, "text", 1, { nested: false }], unicode: "配置" })
    for (const text of ["null", "true", "1", '"text"', '{"__proto__":true}']) {
      expect(() => jsonEtcdDecoder(text, "key")).toThrow()
    }
  })

  test("validates every constructor option and UTF-16 key boundary", () => {
    const fetch = async function fetchEtcd(): Promise<Response> {
      return range({ header: { revision: "1" } })
    }
    const cases: unknown[] = [
      null,
      {},
      { fetch, address: 1, key: "key" },
      { fetch, address: "http://etcd", key: "key", name: "" },
      { fetch, address: "http://etcd", key: "key", token: "" },
      { fetch, address: "http://etcd", key: "key", retryInitialMs: 0 },
      { fetch, address: "http://etcd", key: "key", retryMaximumMs: 0 },
      { fetch, address: "http://etcd", key: "key", decode: true },
      { fetch, address: "http://user@etcd", key: "key" },
      { fetch, address: "http://etcd", key: "\ud800" },
      { fetch, address: "http://etcd", key: "\udc00" }
    ]
    for (const value of cases) expect(() => etcdSource(value as never)).toThrow()
    expect(() =>
      etcdSource({ fetch, address: "http://etcd", key: "paired-\ud83d\udc08" })
    ).not.toThrow()
  })

  test("rejects malformed range envelopes, revisions, base64, and UTF-8", async () => {
    const bodies = [
      {},
      { header: { revision: "01" } },
      { header: { revision: "1" }, kvs: {} },
      { header: { revision: "1" }, kvs: [{ value: "e30=" }, { value: "e30=" }] },
      { header: { revision: "1" }, kvs: [{ value: 1 }] },
      { header: { revision: "1" }, kvs: [{ value: "%%%" }] },
      { header: { revision: "1" }, kvs: [{ value: "/w==" }] }
    ]
    for (const body of bodies) {
      await expect(
        source(async function fetchEtcd() {
          return range(body)
        }).load(background())
      ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_PROTOCOL", operation: "range" })
    }
  })

  test("normalizes synchronous, asynchronous, body, and JSON transport failures", async () => {
    const failures: EtcdFetch[] = [
      function synchronous(): Promise<Response> {
        throw new Error("sync transport secret")
      },
      async function asynchronous(): Promise<Response> {
        throw new Error("async transport secret")
      },
      async function synchronousBody(): Promise<Response> {
        return Object.freeze({
          ok: true,
          status: 200,
          text(): Promise<string> {
            throw new Error("sync body secret")
          }
        }) as unknown as Response
      },
      async function asynchronousBody(): Promise<Response> {
        return Object.freeze({
          ok: true,
          status: 200,
          text(): Promise<string> {
            return Promise.reject(new Error("async body secret"))
          }
        }) as unknown as Response
      }
    ]
    for (const fetch of failures) {
      const failure = await source(fetch)
        .load(background())
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: "GO_LIKE_ETCD_TRANSPORT", operation: "range" })
      expect(String(failure)).not.toContain("secret")
    }

    await expect(
      source(async function invalidJson() {
        return new Response("not-json")
      }).load(background())
    ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_PROTOCOL", operation: "range" })
  })

  test("lets cancellation win a Fetch that cancels synchronously but settles late", async () => {
    const response = deferred<Response>()
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("canceled during Fetch")
    const config = source(function nonCooperative() {
      cancel(reason)
      return response.promise
    })
    const pending = config.load(ctx)

    await expect(pending).rejects.toBe(reason)
    response.resolve(range({ header: { revision: "1" } }))
    await turn()
  })

  test("keeps HTTP status authoritative when error-body access or cancellation is broken", async () => {
    const responses: Response[] = [
      Object.freeze({
        ok: false,
        status: 503,
        get body(): null {
          throw new Error("body getter failed")
        }
      }) as unknown as Response,
      Object.freeze({
        ok: false,
        status: 503,
        body: Object.freeze({
          cancel(): Promise<void> {
            throw new Error("cancel failed")
          }
        })
      }) as unknown as Response,
      new Response(null, { status: 503 })
    ]
    for (const response of responses) {
      await expect(
        source(async function unavailable() {
          return response
        }).load(background())
      ).rejects.toMatchObject({ code: "GO_LIKE_ETCD_HTTP", status: 503 })
    }
  })

  test("rejects malformed watch frames without retrying protocol errors", async () => {
    const frames = [
      "not-json",
      JSON.stringify({ wrong: true }),
      JSON.stringify({ result: { canceled: true } }),
      JSON.stringify({ result: { canceled: true, compact_revision: "0" } }),
      JSON.stringify({ result: { events: true } }),
      JSON.stringify({ result: {} })
    ]
    for (const frame of frames) {
      const config = source(async function malformedWatch() {
        return new Response(`${frame}\n`)
      })
      const watcher = await config.watch?.(background(), "1")
      if (watcher === undefined) throw new Error("watcher missing")
      await expect(watcher.next(background())).rejects.toMatchObject({
        code: "GO_LIKE_ETCD_PROTOCOL",
        operation: "watch"
      })
      await watcher.stop(background())
    }
  })

  test("parses a final watch frame without a newline and accepts an empty event batch", async () => {
    const config = source(async function finalFrame() {
      return new Response(
        `${JSON.stringify({ result: { header: { revision: "2" }, events: [] } })}\n${JSON.stringify({ result: { header: { revision: "2" }, events: [{}] } })}`
      )
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    await watcher.next(background())
    await watcher.stop(background())
  })

  test("turns invalid UTF-8 and an empty stream into terminal-or-cancelable watch outcomes", async () => {
    const invalid = source(async function invalidUtf8() {
      return new Response(new Uint8Array([0xff]))
    })
    const invalidWatcher = await invalid.watch?.(background(), "1")
    if (invalidWatcher === undefined) throw new Error("watcher missing")
    await expect(invalidWatcher.next(background())).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_PROTOCOL"
    })
    await invalidWatcher.stop(background())

    const empty = etcdSource({
      async fetch() {
        return new Response("")
      },
      address: "http://etcd:2379",
      key: "app/config",
      retryInitialMs: 10_000,
      retryMaximumMs: 10_000
    })
    const emptyWatcher = await empty.watch?.(background(), "1")
    if (emptyWatcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("stop empty retry")
    const pending = emptyWatcher.next(ctx)
    await turn()
    cancel(reason)
    await expect(pending).rejects.toBe(reason)
    await emptyWatcher.stop(background())
  })

  test("reconciles after a watch response body transport failure", async () => {
    let calls = 0
    const config = source(async function brokenBody() {
      calls += 1
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          /** Fails the first gateway stream read. */
          start(controller) {
            controller.error(new Error("watch body failed"))
          }
        })
        return new Response(body)
      }
      return range({ header: { revision: "3" } })
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    expect(calls).toBe(2)
    await watcher.stop(background())
  })

  test("cancels retry intervals and keeps non-retryable watch HTTP failures terminal", async () => {
    const retrying = source(async function unavailable() {
      return new Response(null, { status: 503 })
    })
    const retryWatcher = await retrying.watch?.(background(), "1")
    if (retryWatcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("retry canceled")
    const pending = retryWatcher.next(ctx)
    await Promise.resolve()
    cancel(reason)
    await expect(pending).rejects.toBe(reason)
    await retryWatcher.stop(background())

    let ownerCalls = 0
    const ownerRetry = etcdSource({
      async fetch() {
        ownerCalls += 1
        return new Response(null, { status: 503 })
      },
      address: "http://etcd:2379",
      key: "app/config",
      retryInitialMs: 10_000,
      retryMaximumMs: 10_000
    })
    const ownerWatcher = await ownerRetry.watch?.(background(), "1")
    if (ownerWatcher === undefined) throw new Error("watcher missing")
    const ownerPending = ownerWatcher.next(background())
    while (ownerCalls === 0) await Promise.resolve()
    await turn()
    const ownerStopping = ownerWatcher.stop(background())
    await expect(ownerPending).rejects.toThrow("watcher has stopped")
    await ownerStopping

    const terminal = source(async function unauthorized() {
      return new Response(null, { status: 401 })
    })
    const terminalWatcher = await terminal.watch?.(background(), "1")
    if (terminalWatcher === undefined) throw new Error("watcher missing")
    await expect(terminalWatcher.next(background())).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_HTTP",
      status: 401
    })
    await terminalWatcher.stop(background())
  })

  test("enforces watcher concurrency, cursor, and idempotent stop contracts", async () => {
    const blocked = deferred<Response>()
    const config = source(function held() {
      return blocked.promise
    })
    await expect(config.watch?.(background(), "invalid")).rejects.toMatchObject({
      code: "GO_LIKE_ETCD_PROTOCOL"
    })
    const watcher = await config.watch?.(background(), null)
    if (watcher === undefined) throw new Error("watcher missing")
    const pending = watcher.next(background())
    await expect(watcher.next(background())).rejects.toThrow("already waiting")
    const stopping = watcher.stop(background())
    await expect(pending).rejects.toThrow("watcher has stopped")
    await stopping
    await expect(watcher.stop(background())).resolves.toBeUndefined()
    await expect(watcher.next(background())).rejects.toThrow("watcher has stopped")
    blocked.resolve(range({ header: { revision: "1" } }))
  })

  test("observes both asynchronous and synchronous reader cancellation failures", async () => {
    let calls = 0
    const config = source(async function customResponse() {
      calls += 1
      const bytes = new TextEncoder().encode(
        `${JSON.stringify({ result: { header: { revision: String(calls + 1) }, events: [{}] } })}\n`
      )
      let read = false
      return Object.freeze({
        ok: true,
        status: 200,
        body: Object.freeze({
          getReader() {
            return Object.freeze({
              read(): Promise<ReadableStreamReadResult<Uint8Array>> {
                if (read) return Promise.resolve({ done: true, value: undefined })
                read = true
                return Promise.resolve({ done: false, value: bytes })
              },
              cancel(): Promise<void> {
                if (calls === 1) return Promise.reject(new Error("async cancel failure"))
                throw new Error("sync cancel failure")
              }
            })
          }
        })
      }) as unknown as Response
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    await watcher.next(background())
    await turn()
    await watcher.next(background())
    await watcher.stop(background())
  })
})
