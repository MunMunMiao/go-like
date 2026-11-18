import { describe, expect, test } from "bun:test"

import { background, withTimeout } from "@go-like/core/context"
import { jsonDecoder } from "@go-like/core/config"

import { retryableConfigFailure } from "../../src/client/http"
import type { Fetch } from "@go-like/core/fetch"
import { kubernetesSource } from "../../src/config/index"
import { newKubernetesClient } from "../../src/index"

/** Returns one JSON response. */
function response(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

const ApiAddress = "https://kubernetes.example"

/** Creates one client and omits token when it is absent. */
function connect(fetch: Fetch, token?: string) {
  if (token === undefined) return newKubernetesClient({ fetch, address: ApiAddress })
  return newKubernetesClient({ fetch, address: ApiAddress, token })
}

/** Creates one standard source around a controlled Fetch capability. */
function source(fetch: Fetch) {
  return kubernetesSource(connect(fetch), {
    namespace: "orders",
    configMap: "orders-config",
    key: "config.json",
    retryInitialMs: 1,
    retryMaximumMs: 1
  })
}

/** Returns a valid exact ConfigMap object. */
function validResource(): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { namespace: "orders", name: "orders-config", resourceVersion: "1" },
    data: { "config.json": "{}" }
  }
}

describe("Kubernetes configuration protocol boundaries", () => {
  test("admits the complete JSON value domain and rejects unsafe roots and members", () => {
    expect(
      jsonDecoder('{"array":[null,true,"text",1,{"nested":false}],"unicode":"配置"}', "key")
    ).toEqual({ array: [null, true, "text", 1, { nested: false }], unicode: "配置" })
    for (const text of [
      "null",
      "true",
      "1",
      '"text"',
      '{"value":null,"constructor":true}',
      '{"value":null,"nested":{"prototype":true}}',
      '{"number":1e400}'
    ]) {
      expect(() => jsonDecoder(text, "key")).toThrow()
    }
  })

  test("validates every constructor option", () => {
    const fetch = async function fetched(): Promise<Response> {
      return response(validResource())
    }
    const clientCases: unknown[] = [
      null,
      {},
      { fetch: true, address: ApiAddress },
      { fetch, address: 1 },
      { fetch, address: "https://user@kubernetes.example" },
      { fetch, address: "https://kubernetes.example?" },
      { fetch, address: "https://kubernetes.example#" },
      { fetch, address: ApiAddress, token: "" },
      { fetch, address: ApiAddress, token: "private\r\ninjected" },
      { fetch, address: ApiAddress, token: "private\u0000injected" }
    ]
    for (const value of clientCases) expect(() => newKubernetesClient(value as never)).toThrow()
    const client = connect(fetch)
    const sourceCases: unknown[] = [
      null,
      {},
      { namespace: "Orders", configMap: "orders-config", key: "config.json" },
      { namespace: "orders", key: "config.json" },
      {
        namespace: "orders",
        configMap: "orders-config",
        secret: "orders-config",
        key: "config.json"
      },
      { namespace: "orders", configMap: "-invalid", key: "config.json" },
      { namespace: "orders", configMap: "orders-config", key: "invalid/key" },
      { namespace: "orders", configMap: "orders-config", key: "config.json", name: "" },
      { namespace: "orders", configMap: "orders-config", key: "config.json", timeoutMs: 0 },
      {
        namespace: "orders",
        configMap: "orders-config",
        key: "config.json",
        watchTimeoutSeconds: 0
      },
      { namespace: "orders", configMap: "orders-config", key: "config.json", retryInitialMs: 0 },
      { namespace: "orders", configMap: "orders-config", key: "config.json", retryMaximumMs: 0 },
      {
        namespace: "orders",
        configMap: "orders-config",
        key: "config.json",
        retryInitialMs: 2,
        retryMaximumMs: 1
      },
      { namespace: "orders", configMap: "orders-config", key: "config.json", decode: true }
    ]
    for (const value of sourceCases)
      expect(() => kubernetesSource(client, value as never)).toThrow()
    for (const address of ["not a url?private-address", "https://private.example/path"]) {
      const failure = (() => {
        try {
          newKubernetesClient({ fetch, address })
        } catch (error) {
          return error
        }
        throw new Error("invalid address unexpectedly succeeded")
      })()
      expect(String(failure)).not.toContain("private")
    }
    try {
      newKubernetesClient({ fetch, address: ApiAddress, token: "private\r\ninjected" })
      throw new Error("invalid token unexpectedly succeeded")
    } catch (error) {
      expect(String(error)).not.toContain("private")
    }
  })

  test("rejects malformed ConfigMap and Secret envelopes and selected data", async () => {
    const malformed: unknown[] = [
      {},
      { ...validResource(), apiVersion: "v2" },
      { ...validResource(), kind: "Secret" },
      { ...validResource(), metadata: null },
      {
        ...validResource(),
        metadata: { namespace: "foreign", name: "orders-config", resourceVersion: "1" }
      },
      {
        ...validResource(),
        metadata: { namespace: "orders", name: "foreign", resourceVersion: "1" }
      },
      {
        ...validResource(),
        metadata: { namespace: "orders", name: "orders-config", resourceVersion: "" }
      },
      { ...validResource(), data: 1 }
    ]
    for (const body of malformed) {
      await expect(
        source(async function malformedGet() {
          return response(body)
        }).load(background())
      ).rejects.toMatchObject({ code: "GO_LIKE_KUBERNETES_PROTOCOL", operation: "config.get" })
    }

    await expect(
      source(async function missingKey() {
        return response({ ...validResource(), data: {} })
      }).load(background())
    ).rejects.toMatchObject({
      name: "ConfigSourceMissingError",
      code: "GO_LIKE_CONFIG_SOURCE_MISSING"
    })

    for (const encoded of [1, "%%%", "/w=="]) {
      const config = kubernetesSource(
        connect(async function secretGet() {
          return response({
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
              namespace: "orders",
              name: "orders-config",
              resourceVersion: "1"
            },
            data: { "config.json": encoded }
          })
        }),
        {
          namespace: "orders",
          secret: "orders-config",
          key: "config.json"
        }
      )
      await expect(config.load(background())).rejects.toMatchObject({
        code: "GO_LIKE_KUBERNETES_PROTOCOL"
      })
    }
  })

  test("normalizes synchronous, asynchronous, body, and JSON transport failures", async () => {
    const failures: Fetch[] = [
      function synchronous(): Promise<Response> {
        throw new Error("sync private")
      },
      async function asynchronous(): Promise<Response> {
        throw new Error("async private")
      },
      async function synchronousBody(): Promise<Response> {
        return Object.freeze({
          ok: true,
          status: 200,
          text(): Promise<string> {
            throw new Error("body private")
          }
        }) as unknown as Response
      },
      async function asynchronousBody(): Promise<Response> {
        return Object.freeze({
          ok: true,
          status: 200,
          text(): Promise<string> {
            return Promise.reject(new Error("body private"))
          }
        }) as unknown as Response
      }
    ]
    for (const fetch of failures) {
      const failure = await source(fetch)
        .load(background())
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({
        code: "GO_LIKE_KUBERNETES_TRANSPORT",
        operation: "config.get"
      })
      expect(String(failure)).not.toContain("private")
    }

    await expect(
      source(async function invalidJson() {
        return new Response("not-json")
      }).load(background())
    ).rejects.toMatchObject({ code: "GO_LIKE_KUBERNETES_PROTOCOL" })
  })

  test("keeps public boundary error fields immutable", async () => {
    const original = new Error("private transport cause")
    const cases: readonly [Fetch, string, string, number?][] = [
      [
        async () => new Response(null, { status: 403 }),
        "KubernetesHttpError",
        "GO_LIKE_KUBERNETES_HTTP",
        403
      ],
      [
        async () => new Response("invalid-json"),
        "KubernetesProtocolError",
        "GO_LIKE_KUBERNETES_PROTOCOL"
      ],
      [
        async () => {
          throw original
        },
        "KubernetesTransportError",
        "GO_LIKE_KUBERNETES_TRANSPORT"
      ]
    ]
    for (const [fetch, name, code, status] of cases) {
      const error = await source(fetch)
        .load(background())
        .catch((value: unknown) => value)
      expect(error).toBeInstanceOf(Error)
      expect(Object.isFrozen(error)).toBe(true)
      const expected: Record<string, unknown> = { name, code, operation: "config.get" }
      if (status !== undefined) expected.status = status
      if (name === "KubernetesTransportError") expected.cause = original
      for (const [key, value] of Object.entries(expected)) {
        const enumerable = key !== "cause"
        expect(Object.getOwnPropertyDescriptor(error, key)).toEqual({
          value,
          enumerable,
          writable: false,
          configurable: false
        })
      }
      expect(Object.keys(error as object).sort()).toEqual(
        Object.keys(expected)
          .filter((key) => key !== "cause")
          .sort()
      )
      expect(String(error)).not.toContain("private")
    }
  })

  test("keeps HTTP status authoritative when response body cancellation is broken", async () => {
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
      Object.freeze({
        ok: false,
        status: 503,
        body: Object.freeze({
          cancel(): Promise<void> {
            return Promise.reject(new Error("async cancel failed"))
          }
        })
      }) as unknown as Response,
      new Response(null, { status: 503 })
    ]
    for (const unavailable of responses) {
      await expect(
        source(async function failed() {
          return unavailable
        }).load(background())
      ).rejects.toMatchObject({ code: "GO_LIKE_KUBERNETES_HTTP", status: 503 })
    }
    await Bun.sleep(0)
  })

  test("rejects malformed list reconciliation and watch frames", async () => {
    const lists = [
      {},
      { apiVersion: "v2", kind: "ConfigMapList", metadata: { resourceVersion: "2" }, items: [] },
      { apiVersion: "v1", kind: "SecretList", metadata: { resourceVersion: "2" }, items: [] },
      { apiVersion: "v1", kind: "ConfigMapList", metadata: {}, items: [] },
      { apiVersion: "v1", kind: "ConfigMapList", metadata: { resourceVersion: "2" }, items: {} },
      {
        apiVersion: "v1",
        kind: "ConfigMapList",
        metadata: { resourceVersion: "2" },
        items: [validResource(), validResource()]
      },
      {
        apiVersion: "v1",
        kind: "ConfigMapList",
        metadata: { resourceVersion: "2" },
        items: [
          {
            ...validResource(),
            metadata: { namespace: "foreign", name: "orders-config", resourceVersion: "2" }
          }
        ]
      }
    ]
    for (const body of lists) {
      const config = source(async function malformedList() {
        return response(body)
      })
      const watcher = await config.watch?.(background(), null)
      if (watcher === undefined) throw new Error("watcher missing")
      await expect(watcher.next(background())).rejects.toMatchObject({
        code: "GO_LIKE_KUBERNETES_PROTOCOL",
        operation: "config.list"
      })
      await watcher.stop(background())
    }

    const frames = [
      "not-json",
      JSON.stringify({}),
      JSON.stringify({ type: "ERROR", object: { kind: "Status", code: 500 } }),
      JSON.stringify({ type: "BOOKMARK", object: { metadata: {} } }),
      JSON.stringify({ type: "MODIFIED", object: { metadata: {} } }),
      JSON.stringify({ type: "UNKNOWN", object: {} })
    ]
    for (const frame of frames) {
      const config = source(async function malformedWatch() {
        return new Response(`${frame}\n`)
      })
      const watcher = await config.watch?.(background(), "1")
      if (watcher === undefined) throw new Error("watcher missing")
      await expect(watcher.next(background())).rejects.toMatchObject({
        code: "GO_LIKE_KUBERNETES_PROTOCOL",
        operation: "config.watch"
      })
      await watcher.stop(background())
    }
  })

  test("rejects absent watch bodies, oversized frames, and invalid UTF-8", async () => {
    const bodies: Response[] = [
      Object.freeze({ ok: true, status: 200, body: null }) as Response,
      new Response(`{"type":"BOOKMARK","padding":"${"x".repeat(1_048_576)}"}\n`),
      new Response(`{"type":"BOOKMARK","padding":"${"猫".repeat(350_000)}"}\n`),
      new Response(new Uint8Array([0xff]))
    ]
    for (const body of bodies) {
      const config = source(async function malformedStream() {
        return body
      })
      const watcher = await config.watch?.(background(), "1")
      if (watcher === undefined) throw new Error("watcher missing")
      await expect(watcher.next(background())).rejects.toMatchObject({
        code: "GO_LIKE_KUBERNETES_PROTOCOL",
        operation: "config.watch"
      })
      await watcher.stop(background())
    }
  })

  test("reconciles after a watch reader rejects", async () => {
    const requests: URL[] = []
    const config = source(async function interruptedStream(input) {
      requests.push(new URL(input.url))
      if (requests.length === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private transport failure"))
            }
          })
        )
      }
      return response({
        apiVersion: "v1",
        kind: "ConfigMapList",
        metadata: { resourceVersion: "2" },
        items: []
      })
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")

    const [ctx, cancel] = withTimeout(background(), 1_000)
    try {
      await expect(watcher.next(ctx)).resolves.toBeUndefined()
      expect(requests).toHaveLength(2)
      expect(requests[0]?.searchParams.get("watch")).toBe("true")
      expect(requests[0]?.searchParams.get("resourceVersion")).toBe("1")
      expect(requests[1]?.searchParams.has("watch")).toBe(false)
    } finally {
      cancel()
      await watcher.stop(background())
    }
  })

  test("keeps non-retryable admission failures terminal and rejects concurrent next", async () => {
    const config = source(async function forbidden() {
      return response({ kind: "Status" }, 403)
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    const pending = watcher.next(background())
    await expect(watcher.next(background())).rejects.toThrow("already waiting")
    await expect(pending).rejects.toMatchObject({
      code: "GO_LIKE_KUBERNETES_HTTP",
      status: 403
    })
    await watcher.stop(background())
    await expect(watcher.next(background())).rejects.toThrow("has stopped")
  })

  test("handles HTTP 410 watch admission through a fresh LIST", async () => {
    let calls = 0
    const config = source(async function staleAdmission() {
      calls += 1
      if (calls === 1) return response({ kind: "Status" }, 410)
      return response({
        apiVersion: "v1",
        kind: "ConfigMapList",
        metadata: { resourceVersion: "7" },
        items: []
      })
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    await watcher.next(background())
    expect(calls).toBe(2)
    await watcher.stop(background())
  })

  test("retries current HTTP statuses and ignores the retired config HTTP code", () => {
    expect(retryableConfigFailure(newKubernetesClient)).toBe(false)
    expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_CONFIG_HTTP", status: 503 })).toBe(
      false
    )
    expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_CONFIG_TRANSPORT" })).toBe(false)
    expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 503 })).toBe(true)
    expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 425 })).toBe(true)
    expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 400 })).toBe(false)
    expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_TRANSPORT" })).toBe(true)
    const accessor = {}
    Object.defineProperty(accessor, "code", { get: () => "GO_LIKE_KUBERNETES_HTTP" })
    expect(retryableConfigFailure(accessor)).toBe(false)
  })
})
