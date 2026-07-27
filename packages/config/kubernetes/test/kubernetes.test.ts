import { describe, expect, test } from "bun:test"

import { newConfig, onReloadError, source as configSource } from "@likego/config"
import { background, withCancelCause, type Context } from "@likego/context"

import {
  jsonKubernetesDecoder,
  kubernetesSource,
  type KubernetesConfigHttpError,
  type KubernetesFetch
} from "../src/index"
import { deferred } from "./helpers"

/** Encodes one UTF-8 string exactly as Kubernetes Secret data. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Creates one exact Kubernetes object response. */
function resource(
  kind: "ConfigMap" | "Secret",
  revision: string,
  value: string,
  name = "orders-config"
): Response {
  return Response.json({
    apiVersion: "v1",
    kind,
    metadata: { namespace: "orders", name, resourceVersion: revision },
    data: { "config.json": kind === "Secret" ? base64(value) : value }
  })
}

/** Creates one field-selected resource list. */
function list(kind: "ConfigMap" | "Secret", revision: string, present = true): Response {
  return Response.json({
    apiVersion: "v1",
    kind: `${kind}List`,
    metadata: { resourceVersion: revision },
    items: present
      ? [
          {
            apiVersion: "v1",
            kind,
            metadata: {
              namespace: "orders",
              name: "orders-config",
              resourceVersion: revision
            }
          }
        ]
      : []
  })
}

/** Creates a newline-delimited Kubernetes watch response. */
function watch(lines: readonly unknown[], trailingNewline = true): Response {
  const text = lines.map((line) => JSON.stringify(line)).join("\n")
  return new Response(`${text}${trailingNewline ? "\n" : ""}`)
}

/** Creates one standard source around a controlled Fetch capability. */
function source(fetch: KubernetesFetch, kind: "ConfigMap" | "Secret" = "ConfigMap") {
  return kubernetesSource({
    fetch,
    address: "https://kubernetes.example",
    namespace: "orders",
    kind,
    name: "orders-config",
    key: "config.json",
    retryInitialMs: 1,
    retryMaximumMs: 1,
    timeoutMs: 100,
    watchTimeoutSeconds: 5
  })
}

describe("Kubernetes configuration source", () => {
  test("loads one exact ConfigMap key with standard Fetch and resourceVersion", async () => {
    const requests: Request[] = []
    const config = kubernetesSource({
      /** Captures the exact borrowed standard Request. */
      async fetch(request) {
        requests.push(request)
        return resource("ConfigMap", "42", '{"service":{"enabled":true}}')
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "ConfigMap",
      name: "orders-config",
      key: "config.json",
      sourceName: "cluster-config",
      token: "secret-token"
    })

    expect(await config.load(background())).toEqual({
      value: { service: { enabled: true } },
      revision: "42"
    })
    expect(config.name).toBe("cluster-config")
    const request = requests[0]
    if (request === undefined) throw new Error("request missing")
    expect(request.url).toBe(
      "https://kubernetes.example/api/v1/namespaces/orders/configmaps/orders-config"
    )
    expect(request.method).toBe("GET")
    expect(request.redirect).toBe("error")
    expect(request.headers.get("Authorization")).toBe("Bearer secret-token")
  })

  test("strictly decodes Secret base64 and UTF-8 without changing source semantics", async () => {
    const config = source(async function secret() {
      return resource("Secret", "7", '{"unicode":"配置","enabled":true}')
    }, "Secret")

    await expect(config.load(background())).resolves.toEqual({
      value: { unicode: "配置", enabled: true },
      revision: "7"
    })
  })

  test("advances bookmarks and reports update, delete, and recreate events", async () => {
    const cursors: string[] = []
    let call = 0
    const config = source(async function watches(request) {
      const url = new URL(request.url)
      cursors.push(url.searchParams.get("resourceVersion") ?? "")
      call += 1
      const type = call === 1 ? "MODIFIED" : call === 2 ? "DELETED" : "ADDED"
      const revision = String(call + 2)
      const lines: unknown[] =
        call === 1
          ? [
              {
                type: "BOOKMARK",
                object: { metadata: { resourceVersion: "2" } }
              },
              {
                type,
                object: {
                  metadata: {
                    namespace: "orders",
                    name: "orders-config",
                    resourceVersion: revision
                  }
                }
              }
            ]
          : [
              {
                type,
                object: {
                  metadata: {
                    namespace: "orders",
                    name: "orders-config",
                    resourceVersion: revision
                  }
                }
              }
            ]
      return watch(lines)
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    await watcher.next(background())
    await watcher.next(background())
    expect(cursors).toEqual(["1", "3", "4"])
    await watcher.stop(background())
  })

  test("relists after Status 410 and resumes from the fresh collection revision", async () => {
    const requests: URL[] = []
    const config = source(async function stale(request) {
      const url = new URL(request.url)
      requests.push(url)
      if (requests.length === 1) {
        return watch([{ type: "ERROR", object: { apiVersion: "v1", kind: "Status", code: 410 } }])
      }
      if (requests.length === 2) return list("ConfigMap", "20")
      return watch([
        {
          type: "MODIFIED",
          object: {
            metadata: {
              namespace: "orders",
              name: "orders-config",
              resourceVersion: "21"
            }
          }
        }
      ])
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    await watcher.next(background())
    expect(requests[1]?.searchParams.get("fieldSelector")).toBe("metadata.name=orders-config")
    expect(requests[2]?.searchParams.get("resourceVersion")).toBe("20")
    await watcher.stop(background())
  })

  test("reconciles with LIST after a retryable watch transport failure", async () => {
    const paths: string[] = []
    const config = source(async function interrupted(request) {
      paths.push(new URL(request.url).pathname)
      if (paths.length === 1) throw new Error("private transport detail")
      return list("ConfigMap", "12", false)
    })
    const watcher = await config.watch?.(background(), "10")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    expect(paths).toEqual([
      "/api/v1/namespaces/orders/configmaps",
      "/api/v1/namespaces/orders/configmaps"
    ])
    await watcher.stop(background())
  })

  test("reopens clean timed-out streams from the latest bookmark without a dirty event", async () => {
    const cursors: string[] = []
    let calls = 0
    const config = source(async function timed(request) {
      const url = new URL(request.url)
      cursors.push(url.searchParams.get("resourceVersion") ?? "")
      calls += 1
      if (calls === 1) {
        const bytes = new TextEncoder().encode(
          JSON.stringify({ type: "BOOKMARK", object: { metadata: { resourceVersion: "8" } } })
        )
        let read = false
        return Object.freeze({
          ok: true,
          status: 200,
          body: Object.freeze({
            getReader() {
              return Object.freeze({
                read() {
                  if (read) return Promise.resolve({ done: true })
                  read = true
                  return Promise.resolve({ done: false, value: bytes })
                },
                cancel(): Promise<void> {
                  throw new Error("synthetic synchronous cancel")
                }
              })
            }
          })
        }) as unknown as Response
      }
      return watch(
        [
          {
            type: "MODIFIED",
            object: {
              metadata: {
                namespace: "orders",
                name: "orders-config",
                resourceVersion: "9"
              }
            }
          }
        ],
        false
      )
    })
    const watcher = await config.watch?.(background(), "7")
    if (watcher === undefined) throw new Error("watcher missing")

    await watcher.next(background())
    expect(cursors).toEqual(["7", "8"])
    await watcher.stop(background())
  })

  test("preserves Config last-good across deletion and restores on recreation", async () => {
    let value = '{"revision":"initial"}'
    let revision = 1
    const events = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    let watchCalls = 0
    const observedError = deferred<Error>()
    const config = newConfig(
      configSource(
        source(async function lifecycle(request) {
          const url = new URL(request.url)
          if (url.searchParams.get("watch") === "true") {
            const event = events[watchCalls]
            watchCalls += 1
            if (event === undefined) throw new Error("unexpected watch")
            return event.promise
          }
          if (value === "") {
            return Response.json({ kind: "Status", code: 404 }, { status: 404 })
          }
          return resource("ConfigMap", String(revision), value)
        })
      ),
      onReloadError(function reloadFailed(error): void {
        observedError.resolve(error)
      })
    )
    await config.load(background())
    expect(config.value("revision").load()).toBe("initial")

    revision = 2
    value = ""
    events[0]?.resolve(
      watch([
        {
          type: "DELETED",
          object: {
            metadata: {
              namespace: "orders",
              name: "orders-config",
              resourceVersion: "2"
            }
          }
        }
      ])
    )
    await observedError.promise
    expect(config.value("revision").load()).toBe("initial")

    const recreated = deferred<void>()
    config.watch("revision", function changed(_key, current): void {
      if (current.load() === "recreated") recreated.resolve()
    })
    revision = 3
    value = '{"revision":"recreated"}'
    events[1]?.resolve(
      watch([
        {
          type: "ADDED",
          object: {
            metadata: {
              namespace: "orders",
              name: "orders-config",
              resourceVersion: "3"
            }
          }
        }
      ])
    )
    await recreated.promise
    expect(config.value("revision").load()).toBe("recreated")
    await config.close(background())
  })

  test("aborts active watch on stop and preserves caller cancellation cause", async () => {
    const requests: Request[] = []
    const config = source(function blocked(request) {
      requests.push(request)
      return new Promise<Response>(function wait(_resolve, reject) {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true
        })
      })
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    const pending = watcher.next(background())
    const stopping = watcher.stop(background())
    await expect(pending).rejects.toThrow("watcher has stopped")
    await stopping
    expect(requests[0]?.signal.aborted).toBe(true)

    const second = await config.watch?.(background(), "1")
    if (second === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("caller canceled")
    const canceled = second.next(ctx)
    cancel(reason)
    await expect(canceled).rejects.toBe(reason)
    await second.stop(background())
  })

  test("returns caller cancellation while stop drains pending reader cleanup", async () => {
    const reading = deferred<void>()
    const canceling = deferred<void>()
    const canceled = deferred<void>()
    const read = deferred<ReadableStreamReadResult<Uint8Array>>()
    let released = false
    const config = source(async function blockedBody() {
      return Object.freeze({
        ok: true,
        status: 200,
        body: Object.freeze({
          getReader() {
            return Object.freeze({
              read(): Promise<ReadableStreamReadResult<Uint8Array>> {
                reading.resolve()
                return read.promise
              },
              async cancel(): Promise<void> {
                canceling.resolve()
                await canceled.promise
                read.resolve({ done: true, value: new Uint8Array() })
              },
              releaseLock(): void {
                released = true
              }
            })
          }
        })
      }) as unknown as Response
    })
    const watcher = await config.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("caller left pending reader cleanup")
    const pending = watcher.next(ctx)
    await reading.promise

    let nextSettled = false
    let nextFailure: unknown
    const observedNext = pending.then(
      function unexpectedlyFulfilled(): void {
        nextSettled = true
      },
      function rejected(error: unknown): void {
        nextSettled = true
        nextFailure = error
      }
    )
    cancel(reason)
    await canceling.promise
    let stopSettled = false
    const stopping = watcher.stop(background()).then(function stopped(): void {
      stopSettled = true
    })
    await Bun.sleep(0)

    try {
      expect(nextSettled).toBe(true)
      expect(nextFailure).toBe(reason)
      expect(stopSettled).toBe(false)
      expect(released).toBe(false)
    } finally {
      canceled.resolve()
      await observedNext
      await stopping
    }
    expect(released).toBe(true)
  })

  test("keeps authorization failures and decoder failures secret-safe", async () => {
    const unauthorized = source(async function rejected() {
      return new Response("Bearer secret-token and secret document", { status: 403 })
    })
    const failure = await unauthorized.load(background()).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      name: "KubernetesConfigHttpError",
      code: "LIKEGO_KUBERNETES_CONFIG_HTTP",
      operation: "get",
      status: 403
    } satisfies Partial<KubernetesConfigHttpError>)
    expect(String(failure)).not.toContain("secret")

    const decoder = kubernetesSource({
      fetch: async function fetched() {
        return resource("Secret", "1", "private-secret-value")
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "Secret",
      name: "orders-config",
      key: "config.json",
      decode(text) {
        throw new Error(`do not expose ${text}`)
      }
    })
    const decodeFailure = await decoder.load(background()).catch((error: unknown) => error)
    expect(String(decodeFailure)).not.toContain("private-secret-value")
    expect(decodeFailure).toMatchObject({ code: "LIKEGO_KUBERNETES_CONFIG_PROTOCOL" })
  })

  test("validates JSON decoder and constructor boundaries", () => {
    expect(jsonKubernetesDecoder('{"one":1}', "identity")).toEqual({ one: 1 })
    expect(() => jsonKubernetesDecoder("[]", "identity")).toThrow("JSON object")
    expect(() =>
      kubernetesSource({
        fetch: async () => resource("ConfigMap", "1", "{}"),
        address: "ftp://kubernetes",
        namespace: "orders",
        kind: "ConfigMap",
        name: "orders-config",
        key: "config.json"
      })
    ).toThrow("HTTP or HTTPS")
    expect(() =>
      kubernetesSource({
        fetch: async () => resource("ConfigMap", "1", "{}"),
        address: "https://kubernetes/path",
        namespace: "orders",
        kind: "ConfigMap",
        name: "orders-config",
        key: "config.json"
      })
    ).toThrow("origin")
  })

  test("rejects pre-canceled operations without invoking Fetch", async () => {
    let calls = 0
    const config = source(async function forbidden() {
      calls += 1
      return resource("ConfigMap", "1", "{}")
    })
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("already canceled")
    cancel(reason)

    await expect(config.load(ctx)).rejects.toBe(reason)
    await expect(config.watch?.(ctx, "1")).rejects.toBe(reason)
    expect(calls).toBe(0)
  })

  test("lets cancellation win a Fetch that settles after its Context", async () => {
    const pending = deferred<Response>()
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("canceled during Fetch")
    const config = source(function nonCooperative() {
      cancel(reason)
      return pending.promise
    })

    await expect(config.load(ctx)).rejects.toBe(reason)
    pending.reject(new Error("late ignored rejection"))
    await Bun.sleep(0)
  })

  test("bounds GET admission and body read without leaking timeout internals", async () => {
    const admissions: Request[] = []
    const admission = kubernetesSource({
      fetch(request) {
        admissions.push(request)
        return new Promise<Response>(function neverSettles() {})
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "Secret",
      name: "orders-config",
      key: "config.json",
      token: "private-token",
      timeoutMs: 1
    })
    const admissionFailure = await admission.load(background()).catch((error: unknown) => error)
    expect(admissionFailure).toMatchObject({
      code: "LIKEGO_KUBERNETES_CONFIG_TRANSPORT",
      operation: "get"
    })
    expect(String(admissionFailure)).not.toContain("private-token")
    expect(admissions[0]?.signal.aborted).toBe(true)

    const body = kubernetesSource({
      async fetch() {
        return Object.freeze({
          ok: true,
          status: 200,
          text(): Promise<string> {
            return new Promise<string>(function neverSettles() {})
          }
        }) as unknown as Response
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "ConfigMap",
      name: "orders-config",
      key: "config.json",
      timeoutMs: 1
    })
    await expect(body.load(background())).rejects.toMatchObject({
      code: "LIKEGO_KUBERNETES_CONFIG_TRANSPORT",
      operation: "get"
    })
  })

  test("times out watch admission but leaves an admitted resident body to Kubernetes", async () => {
    let admissions = 0
    const admission = kubernetesSource({
      fetch(request) {
        admissions += 1
        if (admissions === 1) {
          return new Promise<Response>(function wait(_resolve, reject) {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true
            })
          })
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              apiVersion: "v1",
              kind: "ConfigMapList",
              metadata: { resourceVersion: "2" },
              items: []
            })
          )
        )
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "ConfigMap",
      name: "orders-config",
      key: "config.json",
      timeoutMs: 1,
      retryInitialMs: 1,
      retryMaximumMs: 1
    })
    const admissionWatcher = await admission.watch?.(background(), "1")
    if (admissionWatcher === undefined) throw new Error("watcher missing")
    await admissionWatcher.next(background())
    expect(admissions).toBe(2)
    await admissionWatcher.stop(background())

    let settled = false
    const resident = kubernetesSource({
      async fetch() {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }))
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "ConfigMap",
      name: "orders-config",
      key: "config.json",
      timeoutMs: 1,
      watchTimeoutSeconds: 1
    })
    const residentWatcher = await resident.watch?.(background(), "1")
    if (residentWatcher === undefined) throw new Error("watcher missing")
    const pending = residentWatcher.next(background()).finally(() => {
      settled = true
    })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    const stopping = residentWatcher.stop(background())
    await expect(pending).rejects.toThrow("watcher has stopped")
    await stopping
  })

  test("cancels an active response body and an in-progress retry interval", async () => {
    const active = source(async function body() {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }))
    })
    const activeWatcher = await active.watch?.(background(), "1")
    if (activeWatcher === undefined) throw new Error("watcher missing")
    const pendingBody = activeWatcher.next(background())
    await Bun.sleep(0)
    const stopped = activeWatcher.stop(background())
    await expect(pendingBody).rejects.toThrow("watcher has stopped")
    await stopped

    const retrying = kubernetesSource({
      fetch: async function unavailable() {
        throw new Error("network unavailable")
      },
      address: "https://kubernetes.example",
      namespace: "orders",
      kind: "ConfigMap",
      name: "orders-config",
      key: "config.json",
      retryInitialMs: 100,
      retryMaximumMs: 100
    })
    const retryWatcher = await retrying.watch?.(background(), "1")
    if (retryWatcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("cancel retry")
    const retry = retryWatcher.next(ctx)
    await Bun.sleep(0)
    cancel(reason)
    await expect(retry).rejects.toBe(reason)
    await retryWatcher.stop(background())

    const ownedRetryWatcher = await retrying.watch?.(background(), "1")
    if (ownedRetryWatcher === undefined) throw new Error("watcher missing")
    const ownedRetry = ownedRetryWatcher.next(background())
    await Bun.sleep(0)
    const ownedStop = ownedRetryWatcher.stop(background())
    await expect(ownedRetry).rejects.toThrow("watcher has stopped")
    await ownedStop
  })
})

const typed = source(async function typedFetch(_request: Request): Promise<Response> {
  return resource("ConfigMap", "1", "{}")
})
const typedLoad: Promise<unknown> = typed.load(background())
const typedContext: Context = background()
void [typedLoad, typedContext]
