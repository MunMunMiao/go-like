import { describe, expect, test } from "bun:test"

import { newConfig, onReloadError, source as configSource } from "@go-like/config"
import { background, withCancelCause, type Context } from "@go-like/context"

import { etcdSource, jsonEtcdDecoder, type EtcdFetch, type EtcdHttpError } from "../src/index"
import { deferred } from "./helpers"

/** Encodes one test string exactly as the gateway does. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Creates one exact range response. */
function rangeResponse(revision: string, value?: string): Response {
  const body: { header: { revision: string }; kvs?: { value: string }[] } = {
    header: { revision }
  }
  if (value !== undefined) body.kvs = [{ value: base64(value) }]
  return Response.json(body)
}

/** Creates a newline-delimited watch response from complete gateway envelopes. */
function watchResponse(lines: readonly unknown[]): Response {
  let body = ""
  for (const line of lines) body += `${JSON.stringify(line)}\n`
  return new Response(body, { headers: { "Content-Type": "application/json" } })
}

describe("etcd configuration source", () => {
  test("loads one linearizable exact key with base64 and borrowed Fetch credentials", async () => {
    const requests: Request[] = []
    /** Captures the exact standard Web request. */
    const fetch: EtcdFetch = async function fetchEtcd(request) {
      requests.push(request)
      return rangeResponse("42", '{"service":{"enabled":true}}')
    }
    const source = etcdSource({
      fetch,
      address: "https://etcd.internal:2379",
      key: "配置/app",
      name: "central-etcd",
      token: "secret-token"
    })

    expect(await source.load(background())).toEqual({
      value: { service: { enabled: true } },
      revision: "42"
    })
    expect(source.name).toBe("central-etcd")
    const request = requests[0]
    if (request === undefined) throw new Error("request missing")
    expect(request.url).toBe("https://etcd.internal:2379/v3/kv/range")
    expect(request.method).toBe("POST")
    expect(request.redirect).toBe("error")
    expect(request.headers.get("Authorization")).toBe("Bearer secret-token")
    expect(await request.json()).toEqual({ key: base64("配置/app") })
  })

  test("maps a missing exact key to an empty source object at the global revision", async () => {
    const source = etcdSource({
      /** Returns a missing-key range response. */
      async fetch() {
        return rangeResponse("7")
      },
      address: "http://etcd:2379",
      key: "missing"
    })

    await expect(source.load(background())).resolves.toEqual({ value: {}, revision: "7" })
  })

  test("starts watch at revision plus one and delivers update and delete events", async () => {
    const starts: string[] = []
    let calls = 0
    const source = etcdSource({
      /** Serves one update watch and one delete watch. */
      async fetch(request) {
        calls += 1
        const body = await request.json()
        starts.push(body.create_request.start_revision)
        return watchResponse([
          { result: { header: { revision: String(10 + calls) }, created: true } },
          {
            result: {
              header: { revision: String(10 + calls) },
              events: calls === 1 ? [{ kv: { mod_revision: "11" } }] : [{ type: "DELETE" }]
            }
          }
        ])
      },
      address: "http://etcd:2379",
      key: "app/config"
    })
    const watcher = await source.watch?.(background(), "10")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    await watcher.next(background())
    expect(starts).toEqual(["11", "12"])
    await watcher.stop(background())
  })

  test("fresh-ranges after compaction before delivering one dirty notification", async () => {
    const paths: string[] = []
    const source = etcdSource({
      /** Returns a compacted watch followed by a fresh range. */
      async fetch(request) {
        paths.push(new URL(request.url).pathname)
        if (paths.length === 1) {
          return watchResponse([
            { result: { header: { revision: "9" }, created: true } },
            { result: { canceled: true, compact_revision: "8" } }
          ])
        }
        return rangeResponse("9", '{"ready":true}')
      },
      address: "http://etcd:2379",
      key: "app/config"
    })
    const watcher = await source.watch?.(background(), "2")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    expect(paths).toEqual(["/v3/watch", "/v3/kv/range"])
    await watcher.stop(background())
  })

  test("reconciles with range after a retryable watch outage", async () => {
    const paths: string[] = []
    const source = etcdSource({
      /** Fails one watch transport then serves recovery range. */
      async fetch(request) {
        paths.push(new URL(request.url).pathname)
        if (paths.length === 1) throw new Error("network unavailable")
        return rangeResponse("12", '{"recovered":true}')
      },
      address: "http://etcd:2379",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "10")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    expect(paths).toEqual(["/v3/watch", "/v3/kv/range"])
    await watcher.stop(background())
  })

  test("preserves Config last-good when a later etcd document is invalid", async () => {
    let value = '{"ready":true}'
    let watchCalls = 0
    const changed = Promise.withResolvers<Response>()
    const reloaded = Promise.withResolvers<Error>()
    const source = etcdSource({
      /** Returns one gated update, then keeps the next watch pending until close. */
      async fetch(request) {
        if (new URL(request.url).pathname === "/v3/watch") {
          watchCalls += 1
          if (watchCalls === 1) return changed.promise
          return new Promise<Response>(function wait(_resolve, reject) {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true
            })
          })
        }
        return rangeResponse("20", value)
      },
      address: "http://etcd:2379",
      key: "app/config"
    })
    const config = newConfig(
      configSource(source),
      onReloadError(function observe(error): void {
        reloaded.resolve(error)
      })
    )
    await config.load(background())
    const good = config.value("ready").load()
    value = "not-json"
    changed.resolve(
      watchResponse([
        { result: { header: { revision: "21" }, created: true } },
        { result: { header: { revision: "21" }, events: [{ kv: { mod_revision: "21" } }] } }
      ])
    )
    await reloaded.promise
    expect(config.value("ready").load()).toBe(good)
    await config.close(background())
  })

  test("aborts an active watch on stop and preserves caller cancellation cause", async () => {
    const requests: Request[] = []
    /** Waits for each standard Request signal to abort. */
    const fetch: EtcdFetch = function fetchEtcd(request) {
      requests.push(request)
      return new Promise<Response>(function wait(_resolve, reject) {
        /** Rejects the blocked Fetch with its exact signal reason. */
        function aborted(): void {
          reject(request.signal.reason)
        }
        request.signal.addEventListener("abort", aborted, { once: true })
      })
    }
    const source = etcdSource({ fetch, address: "http://etcd:2379", key: "app/config" })
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    const pending = watcher.next(background())
    const stopping = watcher.stop(background())
    await expect(pending).rejects.toThrow("watcher has stopped")
    await stopping
    expect(requests[0]?.signal.aborted).toBe(true)

    const second = await source.watch?.(background(), "1")
    if (second === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("caller canceled")
    const canceled = second.next(ctx)
    cancel(reason)
    await expect(canceled).rejects.toBe(reason)
    await second.stop(background())
  })

  test("keeps authentication failures terminal and secret-safe", async () => {
    const source = etcdSource({
      /** Returns one non-retryable gateway authentication failure. */
      async fetch() {
        return new Response("credential rejected: secret-token", { status: 401 })
      },
      address: "http://etcd:2379",
      key: "app/config",
      token: "secret-token"
    })

    const failure = await source.load(background()).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      name: "EtcdHttpError",
      code: "GO_LIKE_ETCD_HTTP",
      operation: "range",
      status: 401
    } satisfies Partial<EtcdHttpError>)
    expect(String(failure)).not.toContain("secret-token")
  })

  test("validates decoder and constructor boundaries", async () => {
    expect(jsonEtcdDecoder('{"one":1}', "key")).toEqual({ one: 1 })
    expect(() => jsonEtcdDecoder("[]", "key")).toThrow("must contain a JSON object")
    expect(() =>
      etcdSource({ fetch: async () => rangeResponse("1"), address: "ftp://etcd", key: "key" })
    ).toThrow("HTTP or HTTPS")
    expect(() =>
      etcdSource({ fetch: async () => rangeResponse("1"), address: "http://etcd/path", key: "key" })
    ).toThrow("origin")
    expect(() =>
      etcdSource({ fetch: async () => rangeResponse("1"), address: "http://etcd?", key: "key" })
    ).toThrow("origin")
    expect(() =>
      etcdSource({ fetch: async () => rangeResponse("1"), address: "http://etcd#", key: "key" })
    ).toThrow("origin")
    expect(() =>
      etcdSource({ fetch: async () => rangeResponse("1"), address: "http://etcd", key: "" })
    ).toThrow("non-empty")
  })

  test("rejects pre-canceled source operations without invoking Fetch", async () => {
    let calls = 0
    const source = etcdSource({
      /** Records any forbidden request after pre-cancellation. */
      async fetch() {
        calls += 1
        return rangeResponse("1")
      },
      address: "http://etcd:2379",
      key: "app/config"
    })
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("already canceled")
    cancel(reason)

    await expect(source.load(ctx)).rejects.toBe(reason)
    await expect(source.watch?.(ctx, "1")).rejects.toBe(reason)
    expect(calls).toBe(0)
  })
})

const typedSource = etcdSource({
  /** Proves the public Fetch boundary. */
  async fetch(_request: Request): Promise<Response> {
    return rangeResponse("1")
  },
  address: "http://etcd:2379",
  key: "typed"
})
const typedLoad: Promise<unknown> = typedSource.load(background())
const typedContext: Context = background()
void [typedLoad, typedContext]
