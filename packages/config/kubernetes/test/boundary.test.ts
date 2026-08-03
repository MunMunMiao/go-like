import { describe, expect, test } from "bun:test"

import { background } from "@likego/context"

import { jsonKubernetesDecoder, kubernetesSource, type KubernetesFetch } from "../src/index"

/** Returns one JSON response. */
function response(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

/** Creates one standard source around a controlled Fetch capability. */
function source(fetch: KubernetesFetch) {
  return kubernetesSource({
    fetch,
    address: "https://kubernetes.example",
    namespace: "orders",
    kind: "ConfigMap",
    name: "orders-config",
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
      jsonKubernetesDecoder(
        '{"array":[null,true,"text",1,{"nested":false}],"unicode":"配置"}',
        "key"
      )
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
      expect(() => jsonKubernetesDecoder(text, "key")).toThrow()
    }
  })

  test("validates every constructor option", () => {
    const fetch = async function fetched(): Promise<Response> {
      return response(validResource())
    }
    const base = {
      fetch,
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "ConfigMap" as const,
      name: "orders-config",
      key: "config.json"
    }
    const cases: unknown[] = [
      null,
      {},
      { ...base, fetch: true },
      { ...base, address: 1 },
      { ...base, address: "https://user@kubernetes.example" },
      { ...base, address: "https://kubernetes.example?" },
      { ...base, address: "https://kubernetes.example#" },
      { ...base, namespace: "Orders" },
      { ...base, kind: "Pod" },
      { ...base, name: "-invalid" },
      { ...base, key: "invalid/key" },
      { ...base, sourceName: "" },
      { ...base, token: "" },
      { ...base, token: "private\r\ninjected" },
      { ...base, token: "private\u0000injected" },
      { ...base, timeoutMs: 0 },
      { ...base, watchTimeoutSeconds: 0 },
      { ...base, retryInitialMs: 0 },
      { ...base, retryMaximumMs: 0 },
      { ...base, retryInitialMs: 2, retryMaximumMs: 1 },
      { ...base, decode: true }
    ]
    for (const value of cases) expect(() => kubernetesSource(value as never)).toThrow()
    for (const address of ["not a url?private-address", "https://private.example/path"]) {
      const failure = (() => {
        try {
          kubernetesSource({ ...base, address })
        } catch (error) {
          return error
        }
        throw new Error("invalid address unexpectedly succeeded")
      })()
      expect(String(failure)).not.toContain("private")
    }
    try {
      kubernetesSource({ ...base, token: "private\r\ninjected" })
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
      { ...validResource(), data: {} }
    ]
    for (const body of malformed) {
      await expect(
        source(async function malformedGet() {
          return response(body)
        }).load(background())
      ).rejects.toMatchObject({ code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL", operation: "get" })
    }

    const secretBase = {
      fetch: async function fetched(): Promise<Response> {
        return response({})
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "Secret" as const,
      name: "orders-config",
      key: "config.json"
    }
    for (const encoded of [1, "%%%", "/w=="]) {
      const config = kubernetesSource({
        ...secretBase,
        async fetch() {
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
        }
      })
      await expect(config.load(background())).rejects.toMatchObject({
        code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL"
      })
    }
  })

  test("normalizes synchronous, asynchronous, body, and JSON transport failures", async () => {
    const failures: KubernetesFetch[] = [
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
        code: "LIKEGO_KUBERNETES_CONFIG_TRANSPORT",
        operation: "get"
      })
      expect(String(failure)).not.toContain("private")
    }

    await expect(
      source(async function invalidJson() {
        return new Response("not-json")
      }).load(background())
    ).rejects.toMatchObject({ code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL" })
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
      ).rejects.toMatchObject({ code: "LIKEGO_KUBERNETES_CONFIG_HTTP", status: 503 })
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
        code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL",
        operation: "list"
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
        code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL",
        operation: "watch"
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
        code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL",
        operation: "watch"
      })
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
      code: "LIKEGO_KUBERNETES_CONFIG_HTTP",
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
})
