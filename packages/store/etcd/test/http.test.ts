import { background, canceled, cause, withCancel, type Context } from "@likego/context"
import { describe, expect, test } from "bun:test"

import { discard, postJson } from "../src/http"
import { captureOptions, type CapturedOptions } from "../src/options"

/** Creates one captured HTTP boundary around a selected Fetch. */
function options(fetch: CapturedOptions["fetch"], token?: string): CapturedOptions {
  return token === undefined
    ? captureOptions({ fetch, address: "http://etcd.test" })
    : captureOptions({ fetch, address: "http://etcd.test", token })
}

/** Returns one Response proxy whose body reader fails in the selected way. */
function failingText(response: Response, asynchronous: boolean): Response {
  return new Proxy(response, {
    get(target, property) {
      if (property === "text") {
        return asynchronous
          ? (): Promise<string> => Promise.reject(new Error("body failed"))
          : (): string => {
              throw new Error("body failed")
            }
      }
      return Reflect.get(target, property, target)
    }
  })
}

/** Creates a custom Context that becomes canceled when the Fetch returns. */
function lateCanceledContext(): readonly [Context, () => void] {
  let stopped = false
  const context: Context = Object.freeze({
    deadline(): readonly [Date, false] {
      return [new Date(0), false]
    },
    done(): null {
      return null
    },
    err() {
      return stopped ? canceled : null
    },
    value(): null {
      return null
    }
  })
  return Object.freeze([
    context,
    /** Moves the custom Context to its terminal state. */
    function stop(): void {
      stopped = true
    }
  ])
}

describe("etcd JSON HTTP boundary", () => {
  test("sends a borrowed Fetch request with standard secret and redirect policy", async () => {
    const requests: Request[] = []
    const result = await postJson(
      background(),
      options((request) => {
        requests.push(request)
        return new Response('{"header":{"revision":"1"}}')
      }, "token-value"),
      "read",
      "/v3/kv/range",
      { key: "aw==" }
    )
    const observed = requests[0]
    if (observed === undefined) throw new Error("Fetch did not receive a request")
    expect(result).toEqual({ header: { revision: "1" } })
    expect(observed.url).toBe("http://etcd.test/v3/kv/range")
    expect(observed.method).toBe("POST")
    expect(observed.redirect).toBe("error")
    expect(observed.headers.get("Authorization")).toBe("Bearer token-value")
    expect(observed.headers.get("Content-Type")).toBe("application/json")
    expect(await observed.text()).toBe('{"key":"aw=="}')
  })

  test("preserves Context causes before, during, and immediately after Fetch", async () => {
    const [before, cancelBefore] = withCancel(background())
    cancelBefore()
    const expectedBefore = cause(before)
    await expect(
      postJson(
        before,
        options(() => new Response("{}")),
        "read",
        "/v3/kv/range",
        {}
      )
    ).rejects.toBe(expectedBefore)

    const [during, cancelDuring] = withCancel(background())
    const pending = postJson(
      during,
      options(
        () =>
          new Promise<Response>(() => {
            cancelDuring()
          })
      ),
      "read",
      "/v3/kv/range",
      {}
    )
    await expect(pending).rejects.toBe(cause(during))

    const [late, stop] = lateCanceledContext()
    await expect(
      postJson(
        late,
        options(
          () =>
            new Promise<Response>((resolve) => {
              queueMicrotask(() => {
                resolve(new Response("body"))
                stop()
              })
            })
        ),
        "read",
        "/v3/kv/range",
        {}
      )
    ).rejects.toBe(canceled)
  })

  test("sanitizes synchronous, asynchronous, and invalid Fetch results", async () => {
    const secret = "native-secret"
    for (const fetch of [
      (): Promise<Response> => {
        throw new Error(secret)
      },
      (): Promise<Response> => Promise.reject(new Error(secret))
    ]) {
      const error = await postJson(
        background(),
        options(fetch, "header-secret"),
        "write",
        "/v3/kv/txn",
        {}
      ).catch((value: unknown) => value)
      expect(error).toMatchObject({ code: "LIKEGO_ETCD_STORE_TRANSPORT", operation: "write" })
      expect(String(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain("header-secret")
    }
    const invalid = await Reflect.apply(postJson, null, [
      background(),
      { origin: "http://etcd.test", token: undefined, fetch: async () => ({}) },
      "read",
      "/v3/kv/range",
      {}
    ]).catch((value: unknown) => value)
    expect(invalid).toMatchObject({ code: "LIKEGO_ETCD_STORE_PROTOCOL" })
  })

  test("parses only numeric gRPC status while retaining no error body", async () => {
    const bodies: readonly [string, number | null][] = [
      ['{"code":5,"message":"secret-message"}', 5],
      ["not-json", null],
      ["null", null],
      ['{"code":"5"}', null],
      ['{"code":1.5}', null],
      [`{"padding":"${"x".repeat(65_536)}"}`, null]
    ]
    for (const [body, expected] of bodies) {
      const error = await postJson(
        background(),
        options(() => new Response(body, { status: 404 })),
        "lease-revoke",
        "/v3/lease/revoke",
        {}
      ).catch((value: unknown) => value)
      expect(error).toMatchObject({
        code: "LIKEGO_ETCD_STORE_HTTP",
        operation: "lease-revoke",
        status: 404,
        grpcCode: expected
      })
      expect(JSON.stringify(error)).not.toContain("secret-message")
    }
  })

  test("maps successful body failures to protocol and failed-body failures to HTTP", async () => {
    for (const response of [
      new Response("not-json"),
      failingText(new Response("{}"), false),
      failingText(new Response("{}"), true)
    ]) {
      await expect(
        postJson(
          background(),
          options(() => response),
          "list",
          "/v3/kv/range",
          {}
        )
      ).rejects.toMatchObject({ code: "LIKEGO_ETCD_STORE_PROTOCOL", operation: "list" })
    }
    await expect(
      postJson(
        background(),
        options(() => failingText(new Response("{}", { status: 503 }), true)),
        "read",
        "/v3/kv/range",
        {}
      )
    ).rejects.toMatchObject({ code: "LIKEGO_ETCD_STORE_HTTP", grpcCode: null })
    await expect(
      postJson(
        background(),
        options(() => new Response("{}")),
        "delete",
        "/v3/kv/txn",
        {
          value: 1n
        }
      )
    ).rejects.toMatchObject({ code: "LIKEGO_ETCD_STORE_PROTOCOL", operation: "delete" })
  })

  test("body discard tolerates absent, rejected, and synchronously failing cancellation", async () => {
    discard(new Response(null))
    const rejected = new Proxy(new Response("body"), {
      get(target, property) {
        if (property === "body") {
          return { cancel: (): Promise<void> => Promise.reject(new Error("ignored")) }
        }
        return Reflect.get(target, property, target)
      }
    })
    discard(rejected)
    await Promise.resolve()
    const throwing = new Proxy(new Response("body"), {
      get(target, property) {
        if (property === "body") {
          return {
            cancel(): never {
              throw new Error("ignored")
            }
          }
        }
        return Reflect.get(target, property, target)
      }
    })
    expect(() => discard(throwing)).not.toThrow()
  })
})
