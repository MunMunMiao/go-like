import { describe, expect, test } from "bun:test"

import { background, withCancelCause, withTimeout, type Context } from "@likego/context"
import { consulSource, jsonConsulDecoder, type ConsulFetch } from "../src/index"
import { deferred } from "./helpers"

/** Creates one successful raw KV response with a Consul blocking index. */
function kvResponse(value: string, index: string): Response {
  return new Response(value, { status: 200, headers: { "X-Consul-Index": index } })
}

describe("Consul KV configuration source", () => {
  test("loads one exact JSON key with standard Request options and opaque revision", async () => {
    const requests: Request[] = []
    /** Captures the standard one-argument Fetch request. */
    const fetch: ConsulFetch = async function fetchConsul(request) {
      requests.push(request)
      return kvResponse('{"http":{"port":8080},"enabled":true}', "42")
    }
    const source = consulSource({
      fetch,
      address: "http://127.0.0.1:8500",
      key: "services/api config",
      token: "secret-token",
      datacenter: "dc-west",
      namespace: "payments",
      consistency: "consistent",
      name: "central-config"
    })

    expect(await source.load(background())).toEqual({
      value: { http: { port: 8080 }, enabled: true },
      revision: "42"
    })
    expect(source.name).toBe("central-config")
    const request = requests[0]
    if (request === undefined) throw new Error("request missing")
    const url = new URL(request.url)
    expect(url.pathname).toBe("/v1/kv/services/api%20config")
    expect(url.searchParams.get("raw")).toBe("true")
    expect(url.searchParams.get("dc")).toBe("dc-west")
    expect(url.searchParams.get("ns")).toBe("payments")
    expect(url.searchParams.has("consistent")).toBe(true)
    expect(request.headers.get("X-Consul-Token")).toBe("secret-token")
    expect(request.redirect).toBe("error")
  })

  test("watch ignores timeout repeats, resets a backwards index, and delivers one real change", async () => {
    const cursors: string[] = []
    const responses = [kvResponse("{}", "10"), kvResponse("{}", "8"), kvResponse("{}", "8")]
    /** Serves controlled blocking responses while recording cursors. */
    const fetch: ConsulFetch = async function fetchConsul(request) {
      cursors.push(new URL(request.url).searchParams.get("index") ?? "missing")
      const response = responses.shift()
      if (response === undefined) throw new Error("unexpected fetch")
      return response
    }
    const source = consulSource({
      fetch,
      address: "http://consul:8500",
      key: "app/config",
      waitMs: 1_000,
      minimumQueryIntervalMs: 5
    })
    const watcher = await source.watch?.(background(), "10")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    expect(cursors).toEqual(["10", "10", "0"])
    await watcher.stop(background())
  })

  test("clamps a zero index to one and rejects concurrent blocking reads", async () => {
    const pending = deferred<Response>()
    const requests: Request[] = []
    /** Holds the first blocking request until the test releases it. */
    const fetch: ConsulFetch = function fetchConsul(request) {
      requests.push(request)
      return pending.promise
    }
    const source = consulSource({ fetch, address: "http://consul:8500", key: "app/config" })
    const watcher = await source.watch?.(background(), "0")
    if (watcher === undefined) throw new Error("watcher missing")
    const next = watcher.next(background())
    await expect(watcher.next(background())).rejects.toThrow("already waiting")
    pending.resolve(kvResponse("{}", "2"))
    await expect(next).resolves.toBeUndefined()
    const request = requests[0]
    if (request === undefined) throw new Error("request missing")
    expect(new URL(request.url).searchParams.get("index")).toBe("1")
    await watcher.stop(background())
  })

  test("aborts blocking Fetch on stop and preserves caller Context cancellation cause", async () => {
    const signals: AbortSignal[] = []
    /** Waits until the standard Request signal aborts. */
    const fetch: ConsulFetch = function fetchConsul(request) {
      signals.push(request.signal)
      return new Promise<Response>(function wait(_resolve, reject) {
        /** Rejects the blocked transport when Fetch observes cancellation. */
        function aborted(): void {
          reject(request.signal.reason)
        }
        request.signal.addEventListener("abort", aborted, { once: true })
      })
    }
    const source = consulSource({ fetch, address: "http://consul:8500", key: "app/config" })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")
    const stoppedNext = watcher.next(background())
    const stop = watcher.stop(background())
    await expect(stoppedNext).rejects.toThrow("Consul watcher has stopped")
    await stop
    expect(signals[0]?.aborted).toBe(true)

    const second = await source.watch?.(background(), "5")
    if (second === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("request canceled")
    const canceledNext = second.next(ctx)
    cancel(reason)
    await expect(canceledNext).rejects.toBe(reason)
    await second.stop(background())
  })

  test("rejects a non-cooperative Fetch success after caller cancellation", async () => {
    const pending = deferred<Response>()
    const source = consulSource({
      /** Ignores Request.signal and returns only after the test releases it. */
      async fetch() {
        return pending.promise
      },
      address: "http://consul:8500",
      key: "app/config"
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("caller canceled")
    const next = watcher.next(ctx)
    cancel(reason)
    pending.resolve(kvResponse("{}", "6"))

    await expect(next).rejects.toBe(reason)
    await watcher.stop(background())
  })

  test("rejects a non-cooperative Fetch success after owner stop", async () => {
    const pending = deferred<Response>()
    const source = consulSource({
      /** Ignores Request.signal and returns only after the test releases it. */
      async fetch() {
        return pending.promise
      },
      address: "http://consul:8500",
      key: "app/config"
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")
    const next = watcher.next(background())
    const stop = watcher.stop(background())
    pending.resolve(kvResponse("{}", "6"))

    await expect(next).rejects.toThrow("watcher has stopped")
    await stop
  })

  test("rejects load when a non-cooperative Fetch cancels Context before returning", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("load canceled")
    const source = consulSource({
      /** Cancels the operation while still returning one syntactically successful response. */
      async fetch() {
        cancel(reason)
        return kvResponse("{}", "1")
      },
      address: "http://consul:8500",
      key: "app/config"
    })

    await expect(source.load(ctx)).rejects.toBe(reason)
  })

  test("observes a late broken body after non-cooperative Fetch makes Context cancellation win", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("load canceled before body read")
    const bodyFailure = new Error("late body failed")
    const source = consulSource({
      /** Cancels before returning a success response whose body then rejects. */
      async fetch() {
        cancel(reason)
        const body = new ReadableStream<Uint8Array>({
          /** Rejects the body Promise after cancellation already became observable. */
          start(controller) {
            controller.error(bodyFailure)
          }
        })
        return new Response(body, { status: 200, headers: { "X-Consul-Index": "1" } })
      },
      address: "http://consul:8500",
      key: "app/config"
    })

    await expect(source.load(ctx)).rejects.toBe(reason)
  })

  test("rate-limits immediate unchanged responses and cancels the interval with Context", async () => {
    let requests = 0
    /** Returns the unchanged cursor immediately to enter the rate-limit interval. */
    const fetch: ConsulFetch = async function fetchConsul() {
      requests += 1
      return kvResponse("{}", "5")
    }
    const source = consulSource({
      fetch,
      address: "http://consul:8500",
      key: "app/config",
      minimumQueryIntervalMs: 10_000
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("rate-limit canceled")
    const next = watcher.next(ctx)
    while (requests === 0) await Promise.resolve()
    await new Promise<void>(function wait(resolve) {
      setTimeout(resolve, 5)
    })
    cancel(reason)
    await expect(next).rejects.toBe(reason)
    expect(requests).toBe(1)
    await watcher.stop(background())
  })

  test("recovers one watcher across transport, unavailable, and missing-key outages", async () => {
    const responses: Array<Error | Response> = [
      new Error("network unavailable"),
      new Response("unavailable", { status: 503 }),
      new Response("missing", { status: 404 }),
      kvResponse("{}", "5")
    ]
    let requests = 0
    /** Serves three retryable outages followed by one advancing Consul index. */
    const fetch: ConsulFetch = async function fetchConsul() {
      requests += 1
      const response = responses.shift()
      if (response === undefined) throw new Error("unexpected retry")
      if (response instanceof Error) throw response
      return response
    }
    const source = consulSource({
      fetch,
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 2
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withTimeout(background(), 1_000)

    await watcher.next(ctx).finally(cancel)
    expect(requests).toBe(4)
    await watcher.stop(background())
  })

  test("retries a successful response whose body transport fails", async () => {
    const bodyFailure = new Error("response body transport failed")
    let requests = 0
    const source = consulSource({
      /** Returns one broken successful body before a healthy reconciliation response. */
      async fetch() {
        requests += 1
        if (requests === 1) {
          const body = new ReadableStream<Uint8Array>({
            /** Fails the transport while the success body is being consumed. */
            start(controller) {
              controller.error(bodyFailure)
            }
          })
          return new Response(body, { status: 200, headers: { "X-Consul-Index": "5" } })
        }
        return kvResponse("{}", "6")
      },
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    expect(requests).toBe(2)
    await watcher.stop(background())
  })

  test("retries a successful response whose text invocation throws synchronously", async () => {
    const bodyFailure = new Error("response text invocation failed")
    let requests = 0
    const malformed = Object.freeze({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers({ "X-Consul-Index": "5" }),
      /** Throws synchronously instead of returning a body Promise. */
      text(): Promise<string> {
        throw bodyFailure
      }
    })
    const source = consulSource({
      /** Returns one malformed success response before a healthy reconciliation response. */
      async fetch() {
        requests += 1
        return requests === 1 ? (malformed as unknown as Response) : kvResponse("{}", "6")
      },
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    expect(requests).toBe(2)
    await watcher.stop(background())
  })

  test("keeps retryable HTTP status authoritative when its error body is broken", async () => {
    const bodyFailure = new Error("unavailable body failed")
    let requests = 0
    const source = consulSource({
      /** Returns one 503 with a broken body before a healthy response. */
      async fetch() {
        requests += 1
        if (requests === 1) {
          const body = new ReadableStream<Uint8Array>({
            /** Fails if any consumer attempts to drain the unavailable response. */
            start(controller) {
              controller.error(bodyFailure)
            }
          })
          return new Response(body, { status: 503 })
        }
        return kvResponse("{}", "6")
      },
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    expect(requests).toBe(2)
    await watcher.stop(background())
  })

  test("starts error-body cancellation without letting a non-settling cancel delay status retry", async () => {
    let cancellations = 0
    let requests = 0
    const unavailable = Object.freeze({
      ok: false,
      status: 503,
      body: Object.freeze({
        /** Records cancellation but never settles its malformed cancellation Promise. */
        cancel(): Promise<void> {
          cancellations += 1
          return new Promise<void>(function neverSettles() {})
        }
      })
    })
    const source = consulSource({
      /** Returns one non-drainable 503 before a healthy reconciliation response. */
      async fetch() {
        requests += 1
        return requests === 1 ? (unavailable as unknown as Response) : kvResponse("{}", "6")
      },
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    expect({ requests, cancellations }).toEqual({ requests: 2, cancellations: 1 })
    await watcher.stop(background())
  })

  test("keeps retryable HTTP status authoritative when the response body getter throws", async () => {
    const bodyFailure = new Error("response body getter failed")
    let requests = 0
    const unavailable = Object.defineProperties(
      {},
      {
        ok: { value: false },
        status: { value: 503 },
        body: {
          /** Throws before body cancellation can begin. */
          get() {
            throw bodyFailure
          }
        }
      }
    )
    const source = consulSource({
      /** Returns one malformed 503 before a healthy reconciliation response. */
      async fetch() {
        requests += 1
        return requests === 1 ? (unavailable as Response) : kvResponse("{}", "6")
      },
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    expect(requests).toBe(2)
    await watcher.stop(background())
  })

  test("keeps terminal HTTP status authoritative when body cancellation throws synchronously", async () => {
    const cancelFailure = new Error("body cancel failed")
    const response = Object.freeze({
      ok: false,
      status: 403,
      body: Object.freeze({
        /** Throws from a malformed Response body cancellation capability. */
        cancel(): Promise<void> {
          throw cancelFailure
        }
      })
    })
    const source = consulSource({
      /** Returns the controlled authorization response. */
      async fetch() {
        return response as unknown as Response
      },
      address: "http://consul:8500",
      key: "app/config"
    })

    await expect(source.load(background())).rejects.toMatchObject({
      code: "LIKEGO_CONSUL_HTTP",
      status: 403
    })
  })

  test("lets Context cancellation bound a non-cooperative successful response body", async () => {
    const [ctx, cancel] = withTimeout(background(), 10)
    const reason = ctx.err()
    const body = new ReadableStream<Uint8Array>({
      /** Leaves body consumption pending even after the Request signal aborts. */
      pull() {
        return new Promise<void>(function neverSettles() {})
      }
    })
    const source = consulSource({
      /** Returns a syntactically successful response with a non-cooperative body. */
      async fetch() {
        return new Response(body, { status: 200, headers: { "X-Consul-Index": "1" } })
      },
      address: "http://consul:8500",
      key: "app/config"
    })

    const failure = await source
      .load(ctx)
      .catch(function capture(error: unknown) {
        return error
      })
      .finally(cancel)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toBe(ctx.err())
    expect(reason).toBeNull()
  }, 500)

  test("treats authorization failure as terminal instead of retrying forever", async () => {
    let requests = 0
    const source = consulSource({
      /** Returns one non-retryable authorization response. */
      async fetch() {
        requests += 1
        return new Response("denied", { status: 403 })
      },
      address: "http://consul:8500",
      key: "app/config",
      retryInitialMs: 1,
      retryMaximumMs: 2
    })
    const watcher = await source.watch?.(background(), "5")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).rejects.toMatchObject({
      code: "LIKEGO_CONSUL_HTTP",
      status: 403
    })
    expect(requests).toBe(1)
    await watcher.stop(background())
  })

  test("rejects a pre-canceled watch Context with its exact cause", async () => {
    const reason = new Error("watch canceled")
    const [ctx, cancel] = withCancelCause(background())
    cancel(reason)
    const source = consulSource({
      /** Would fail the test if watch construction performed a request. */
      async fetch() {
        throw new Error("unexpected fetch")
      },
      address: "http://consul:8500",
      key: "app/config"
    })

    await expect(source.watch?.(ctx, "5")).rejects.toBe(reason)
  })

  test("returns malformed Context inspection failure as a rejected watch promise", async () => {
    const failure = new Error("Context inspection failed")
    const malformed: Context = {
      /** Returns an absent deadline. */
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      /** Returns an uncancelable signal boundary. */
      done() {
        return null
      },
      /** Fails the required Context inspection boundary. */
      err(): null {
        throw failure
      },
      /** Returns no Context value. */
      value() {
        return undefined
      }
    }
    const source = consulSource({
      /** Would fail the test if malformed watch construction performed a request. */
      async fetch() {
        throw new Error("unexpected fetch")
      },
      address: "http://consul:8500",
      key: "app/config"
    })

    await expect(source.watch?.(malformed, "5")).rejects.toBe(failure)
  })

  test("reports HTTP and protocol failures without leaking token or response content", async () => {
    const source = consulSource({
      /** Returns an authorization failure containing secret body text that must not escape. */
      async fetch() {
        return new Response("server-secret", { status: 403 })
      },
      address: "http://consul:8500",
      key: "private/config",
      token: "client-secret"
    })
    const failure = await source.load(background()).catch(function capture(error: unknown) {
      return error
    })
    expect(failure).toMatchObject({
      name: "ConsulHttpError",
      code: "LIKEGO_CONSUL_HTTP",
      status: 403,
      key: "private/config"
    })
    expect(String(failure)).not.toContain("server-secret")
    expect(String(failure)).not.toContain("client-secret")

    const indexlessResponse = new Response("{}", { status: 200 })
    const missingIndex = consulSource({
      /** Returns success without the required blocking cursor. */
      async fetch() {
        return indexlessResponse
      },
      address: "http://consul:8500",
      key: "app/config"
    })
    await expect(missingIndex.load(background())).rejects.toThrow("X-Consul-Index")
    expect(indexlessResponse.bodyUsed).toBe(true)
  })

  test("validates JSON, addresses, keys, wait bounds, consistency, and callback options", () => {
    expect(() => jsonConsulDecoder("[]", "key")).toThrow("JSON object")
    expect(() => jsonConsulDecoder("{", "key")).toThrow()
    const fetch: ConsulFetch = async function fetchConsul() {
      return kvResponse("{}", "1")
    }
    expect(() => consulSource({ fetch, address: "ftp://consul", key: "x" })).toThrow("HTTP")
    expect(() => consulSource({ fetch, address: "http://consul/path", key: "x" })).toThrow("origin")
    expect(() => consulSource({ fetch, address: "http://consul?", key: "x" })).toThrow("origin")
    expect(() => consulSource({ fetch, address: "http://consul#", key: "x" })).toThrow("origin")
    expect(() => consulSource({ fetch, address: "http://consul", key: "" })).toThrow("key")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "services/../admin" })
    ).toThrow("dot path")
    expect(() => consulSource({ fetch, address: "http://consul", key: "x", waitMs: 0 })).toThrow(
      "waitMs"
    )
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", waitMs: 600_001 })
    ).toThrow("waitMs")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", minimumQueryIntervalMs: 0 })
    ).toThrow("minimumQueryIntervalMs")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", minimumQueryIntervalMs: 60_001 })
    ).toThrow("minimumQueryIntervalMs")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", retryInitialMs: 0 })
    ).toThrow("retryInitialMs")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", retryMaximumMs: 0 })
    ).toThrow("retryMaximumMs")
    expect(() =>
      consulSource({
        fetch,
        address: "http://consul",
        key: "x",
        retryInitialMs: 10,
        retryMaximumMs: 5
      })
    ).toThrow("retryMaximumMs")
    expect(() =>
      consulSource({
        fetch,
        address: "http://consul",
        key: "x",
        consistency: JSON.parse('"wrong"')
      })
    ).toThrow("consistency")
  })

  test("decodes the complete JSON domain and rejects unsafe keys", () => {
    expect(jsonConsulDecoder('{"values":[null,true,7,"text",{"nested":[]}]}', "key")).toEqual({
      values: [null, true, 7, "text", { nested: [] }]
    })
    expect(() => jsonConsulDecoder('{"__proto__":"bad"}', "key")).toThrow("JSON object")
    expect(() => jsonConsulDecoder('{"values":[{"__proto__":"bad"}]}', "key")).toThrow(
      "JSON object"
    )
    expect(() => jsonConsulDecoder("null", "key")).toThrow("JSON object")
    expect(() => jsonConsulDecoder("7", "key")).toThrow("JSON object")
    const parse = JSON.parse
    try {
      /** Simulates a compromised parser boundary returning a non-JSON primitive. */
      JSON.parse = function parseInvalid() {
        return { invalid: Symbol("invalid-json") }
      }
      expect(() => jsonConsulDecoder("{}", "key")).toThrow("JSON object")
    } finally {
      JSON.parse = parse
    }
  })

  test("validates every secret and naming boundary without issuing a request", () => {
    const fetch: ConsulFetch = async function fetchConsul() {
      return kvResponse("{}", "1")
    }
    expect(() => consulSource(JSON.parse("null"))).toThrow("options")
    expect(() =>
      consulSource({ fetch: JSON.parse('"no"'), address: "http://consul", key: "x" })
    ).toThrow("Fetch")
    expect(() => consulSource({ fetch, address: JSON.parse("1"), key: "x" })).toThrow("address")
    expect(() => consulSource({ fetch, address: "http://consul", key: "x", name: "" })).toThrow(
      "source name"
    )
    expect(() => consulSource({ fetch, address: "http://consul", key: "x", token: "" })).toThrow(
      "token"
    )
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", datacenter: "" })
    ).toThrow("datacenter")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", namespace: "" })
    ).toThrow("namespace")
    expect(() =>
      consulSource({ fetch, address: "http://consul", key: "x", decode: JSON.parse('"no"') })
    ).toThrow("decoder")
  })

  test("supports stale reads and makes watcher shutdown idempotent", async () => {
    const requests: Request[] = []
    /** Returns one load response while recording the selected consistency query. */
    const fetch: ConsulFetch = async function fetchConsul(request) {
      requests.push(request)
      return kvResponse("{}", "1")
    }
    const source = consulSource({ fetch, address: "http://consul", key: "x", consistency: "stale" })
    await source.load(background())
    const request = requests[0]
    if (request === undefined) throw new Error("request missing")
    expect(new URL(request.url).searchParams.has("stale")).toBe(true)

    const watcher = await source.watch?.(background(), null)
    if (watcher === undefined) throw new Error("watcher missing")
    await watcher.stop(background())
    await watcher.stop(background())
    await expect(watcher.next(background())).rejects.toThrow("stopped")
  })

  test("preserves every Context cancellation checkpoint and fallback cause", async () => {
    const failure = new Error("checkpoint canceled")
    /** Creates a structural Context whose cancellation state is controlled by the test. */
    function controlledContext(readFailure: () => Error | null): Context {
      return {
        /** Returns an absent deadline. */
        deadline(): readonly [Date, boolean] {
          return [new Date(0), false]
        },
        /** Returns an uncancelable signal boundary. */
        done(): AbortSignal | null {
          return null
        },
        /** Returns the controlled terminal state. */
        err(): Error | null {
          return readFailure()
        },
        /** Returns no Context value. */
        value(): unknown {
          return undefined
        }
      }
    }

    const neverFetch = consulSource({
      /** Fails if an initially canceled load performs network work. */
      async fetch() {
        throw new Error("unexpected fetch")
      },
      address: "http://consul",
      key: "x"
    })
    await expect(neverFetch.load(controlledContext(() => failure))).rejects.toBe(failure)

    let fallbackReads = 0
    const fallback = controlledContext(() => {
      fallbackReads += 1
      return fallbackReads === 1 ? failure : null
    })
    await expect(neverFetch.load(fallback)).rejects.toBe(failure)

    let queryCanceled = false
    const queryContext = controlledContext(() => (queryCanceled ? failure : null))
    const querySource = consulSource({
      /** Makes cancellation visible only after the network response is complete. */
      async fetch() {
        queryCanceled = true
        return kvResponse("{}", "1")
      },
      address: "http://consul",
      key: "x"
    })
    await expect(querySource.load(queryContext)).rejects.toBe(failure)

    let watcherQueryCanceled = false
    const watcherQueryContext = controlledContext(() => (watcherQueryCanceled ? failure : null))
    const watcherQuerySource = consulSource({
      /** Makes cancellation visible only after one blocking query is complete. */
      async fetch() {
        watcherQueryCanceled = true
        return kvResponse("{}", "2")
      },
      address: "http://consul",
      key: "x"
    })
    const queryWatcher = await watcherQuerySource.watch?.(background(), "1")
    if (queryWatcher === undefined) throw new Error("watcher missing")
    await expect(queryWatcher.next(watcherQueryContext)).rejects.toBe(failure)
    await queryWatcher.stop(background())

    let decodeCanceled = false
    const decodeContext = controlledContext(() => (decodeCanceled ? failure : null))
    const decodeSource = consulSource({
      /** Returns a valid response before decode changes the Context state. */
      async fetch() {
        return kvResponse("{}", "1")
      },
      address: "http://consul",
      key: "x",
      /** Cancels after the query checkpoint but before final publication. */
      decode() {
        decodeCanceled = true
        return {}
      }
    })
    await expect(decodeSource.load(decodeContext)).rejects.toBe(failure)
  })

  test("covers terminal watcher protocol boundaries without retrying malformed data", async () => {
    const missingIndex = consulSource({
      /** Returns a malformed success response without a blocking index. */
      async fetch() {
        return new Response("{}")
      },
      address: "http://consul",
      key: "x"
    })
    const missingWatcher = await missingIndex.watch?.(background(), "1")
    if (missingWatcher === undefined) throw new Error("watcher missing")
    await expect(missingWatcher.next(background())).rejects.toThrow("X-Consul-Index")
    await missingWatcher.stop(background())

    const malformedStatus = Object.freeze({
      ok: false,
      status: "unavailable",
      body: null
    })
    const malformedSource = consulSource({
      /** Returns a structurally malformed status to prove retry classification is fail-closed. */
      async fetch() {
        return malformedStatus as unknown as Response
      },
      address: "http://consul",
      key: "x"
    })
    const malformedWatcher = await malformedSource.watch?.(background(), "1")
    if (malformedWatcher === undefined) throw new Error("watcher missing")
    await expect(malformedWatcher.next(background())).rejects.toMatchObject({
      code: "LIKEGO_CONSUL_HTTP",
      status: "unavailable"
    })
    await malformedWatcher.stop(background())
  })

  test("handles pre-canceled retry waits and stop side effects at watcher checkpoints", async () => {
    const controller = new AbortController()
    const reason = new Error("retry wait canceled")
    controller.abort(reason)
    const preCanceledSignal: Context = {
      /** Returns an absent deadline. */
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      /** Returns an already-aborted signal while leaving err neutral. */
      done(): AbortSignal {
        return controller.signal
      },
      /** Leaves cancellation to the standard signal boundary. */
      err(): null {
        return null
      },
      /** Returns no Context value. */
      value(): unknown {
        return undefined
      }
    }
    const unavailable = consulSource({
      /** Ignores the Request signal and returns retryable unavailability. */
      async fetch() {
        return new Response(null, { status: 503 })
      },
      address: "http://consul",
      key: "x",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const unavailableWatcher = await unavailable.watch?.(background(), "1")
    if (unavailableWatcher === undefined) throw new Error("watcher missing")
    await expect(unavailableWatcher.next(preCanceledSignal)).rejects.toBe(reason)
    await unavailableWatcher.stop(background())

    const created = consulSource({
      /** Returns a stable successful response. */
      async fetch() {
        return kvResponse("{}", "2")
      },
      address: "http://consul",
      key: "x"
    })
    const initiallyCanceledWatcher = await created.watch?.(background(), "1")
    if (initiallyCanceledWatcher === undefined) throw new Error("watcher missing")
    const [canceledContext, cancel] = withCancelCause(background())
    cancel(reason)
    await expect(initiallyCanceledWatcher.next(canceledContext)).rejects.toBe(reason)
    await initiallyCanceledWatcher.stop(background())

    let intervalRequests = 0
    const unchanged = consulSource({
      /** Returns an unchanged cursor so the watcher enters its rate-limit interval. */
      async fetch() {
        intervalRequests += 1
        return kvResponse("{}", "1")
      },
      address: "http://consul",
      key: "x",
      minimumQueryIntervalMs: 10_000
    })
    const intervalWatcher = await unchanged.watch?.(background(), "1")
    if (intervalWatcher === undefined) throw new Error("watcher missing")
    const intervalNext = intervalWatcher.next(background())
    while (intervalRequests === 0) await Promise.resolve()
    await new Promise<void>(function wait(resolve) {
      setTimeout(resolve, 5)
    })
    const intervalStop = intervalWatcher.stop(background())
    await expect(intervalNext).rejects.toThrow("stopped")
    await intervalStop

    const stoppedAtCheckpoint = await created.watch?.(background(), "1")
    if (stoppedAtCheckpoint === undefined) throw new Error("watcher missing")
    let reads = 0
    const sideEffectContext: Context = {
      /** Returns an absent deadline. */
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      /** Returns an uncancelable signal boundary. */
      done(): null {
        return null
      },
      /** Stops the owner only after the query has completed. */
      err(): null {
        reads += 1
        if (reads === 2) void stoppedAtCheckpoint.stop(background())
        return null
      },
      /** Returns no Context value. */
      value(): unknown {
        return undefined
      }
    }
    await expect(stoppedAtCheckpoint.next(sideEffectContext)).rejects.toThrow("stopped")
  })

  test("retries a status with no response body before publishing recovery", async () => {
    let requests = 0
    const unavailable = Object.freeze({ ok: false, status: 503, body: null })
    const source = consulSource({
      /** Returns one bodyless outage before a healthy response. */
      async fetch() {
        requests += 1
        return requests === 1 ? (unavailable as unknown as Response) : kvResponse("{}", "2")
      },
      address: "http://consul",
      key: "x",
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    await watcher.next(background())
    expect(requests).toBe(2)
    await watcher.stop(background())
  })
})
