import { describe, expect, test } from "bun:test"

import {
  newConfig,
  source as configSource,
  type ConfigObject,
  type ConfigSourceWatcher
} from "@go-like/config"
import { background, withCancelCause, withTimeout } from "@go-like/context"

import { vaultSource, type VaultFetch, type VaultSourceOptions } from "../src/index"
import { deferred, flush } from "./helpers"

/** Mirrors the documented opaque generation token without reaching into provider internals. */
function revisionToken(
  version: number,
  createdTime = `2026-08-03T00:00:00.${String(version).padStart(9, "0")}Z`
): string {
  return JSON.stringify([1, version, createdTime])
}

/** Creates one valid KV v2 JSON response. */
function kvResponse(
  version: number,
  value: ConfigObject,
  createdTime = `2026-08-03T00:00:00.${String(version).padStart(9, "0")}Z`
): Response {
  return new Response(
    JSON.stringify({ data: { data: value, metadata: { version, created_time: createdTime } } }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  )
}

/** Creates one minimal valid source option object. */
function validOptions(fetch: VaultFetch): VaultSourceOptions {
  return {
    fetch,
    address: "https://vault.example",
    mount: "secret",
    path: "applications/orders/config",
    pollIntervalMs: 1,
    retryInitialMs: 1,
    retryMaximumMs: 2
  }
}

/** Waits until one condition becomes true or a short test deadline expires. */
async function waitUntil(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise<void>(function pause(resolve) {
      setTimeout(resolve, 2)
    })
  }
  throw new Error("condition was not observed before the test deadline")
}

/** Opens one watcher from a constructed source and fails if watch is unexpectedly absent. */
async function watcher(
  options: VaultSourceOptions,
  revision: string | null
): Promise<ConfigSourceWatcher> {
  const source = vaultSource(options)
  if (source.watch === undefined) throw new Error("Vault source watch capability is missing")
  return source.watch(background(), revision)
}

describe("Vault KV v2 source construction and load", () => {
  test("loads, detaches, freezes, and revisions a complete KV v2 data object", async () => {
    const requests: Request[] = []
    const value = {
      enabled: true,
      count: 2,
      empty: null,
      label: "orders",
      nested: { values: [1, false, "three"] }
    }
    const options = {
      fetch: async function fetchVault(request: Request): Promise<Response> {
        requests.push(request)
        return kvResponse(7, value)
      },
      address: "https://vault.example:8200",
      mount: "team mount",
      path: "applications/orders config",
      token: "root-token",
      name: "primary-vault",
      namespace: "platform/team",
      pollIntervalMs: 1,
      retryInitialMs: 1,
      retryMaximumMs: 2
    }
    const source = vaultSource(options)
    options.address = "https://wrong.example"
    options.token = "wrong-token"
    const snapshot = await source.load(background())
    value.enabled = false

    expect(source.name).toBe("primary-vault")
    expect(snapshot).toEqual({
      value: {
        enabled: true,
        count: 2,
        empty: null,
        label: "orders",
        nested: { values: [1, false, "three"] }
      },
      revision: revisionToken(7)
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.value)).toBe(true)
    expect(Object.isFrozen(snapshot.value.nested)).toBe(true)
    const request = requests[0]
    if (request === undefined) throw new Error("Vault request was not captured")
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/v1/team%20mount/data/applications/orders%20config")
    expect(request.redirect).toBe("error")
    expect(request.headers.get("Accept")).toBe("application/json")
    expect(request.headers.get("X-Vault-Token")).toBe("root-token")
    expect(request.headers.get("X-Vault-Namespace")).toBe("platform/team")
  })

  test("loads without optional headers or an AbortSignal", async () => {
    const requests: Request[] = []
    const source = vaultSource({
      fetch: async function fetchVault(request) {
        requests.push(request)
        return kvResponse(1, {})
      },
      address: "http://127.0.0.1:8200/",
      mount: "secret",
      path: "config"
    })
    await expect(source.load(background())).resolves.toMatchObject({
      revision: revisionToken(1),
      value: {}
    })
    const request = requests[0]
    if (request === undefined) throw new Error("Vault request was not captured")
    expect(request.headers.has("X-Vault-Token")).toBe(false)
    expect(request.headers.has("X-Vault-Namespace")).toBe(false)
  })

  test("rejects malformed option capabilities, routes, headers, and durations", () => {
    const fetch: VaultFetch = async function fetchVault() {
      return kvResponse(1, {})
    }
    const malformed = JSON.parse("null")
    expect(() => vaultSource(malformed)).toThrow("options must be an object")

    const hostile = validOptions(fetch)
    Object.defineProperty(hostile, "address", {
      get() {
        throw new Error("secret getter value")
      }
    })
    expect(() => vaultSource(hostile)).toThrow("options could not be read")

    const cases = [
      ["fetch", null],
      ["address", 1],
      ["address", "not a url"],
      ["address", "ftp://vault.example"],
      ["address", "https://user:pass@vault.example"],
      ["address", "https://vault.example/path"],
      ["address", "https://vault.example?query=1"],
      ["address", "https://vault.example?"],
      ["address", "https://vault.example#"],
      ["address", "https://vault.example#fragment"],
      ["mount", null],
      ["mount", ""],
      ["mount", "/secret"],
      ["mount", "secret/"],
      ["mount", "secret//nested"],
      ["mount", "."],
      ["mount", ".."],
      ["mount", "\ud800"],
      ["mount", "\udc00"],
      ["mount", "\ud800x"],
      ["path", null],
      ["path", ""],
      ["path", "config/../secret"],
      ["name", ""],
      ["name", null],
      ["token", ""],
      ["token", null],
      ["token", "line\nbreak"],
      ["token", "\ud800"],
      ["namespace", ""],
      ["namespace", null],
      ["namespace", "line\rbreak"],
      ["pollIntervalMs", 0],
      ["pollIntervalMs", 600_001],
      ["pollIntervalMs", 1.5],
      ["retryInitialMs", 0],
      ["retryInitialMs", 60_001],
      ["retryMaximumMs", 0],
      ["retryMaximumMs", 600_001]
    ]
    for (const entry of cases) {
      const option = validOptions(fetch)
      const key = entry[0]
      if (typeof key !== "string") throw new Error("invalid option fixture")
      Object.defineProperty(option, key, { enumerable: true, value: entry[1] })
      expect(() => vaultSource(option)).toThrow(TypeError)
    }
    expect(() =>
      vaultSource({
        fetch,
        address: "https://vault.example",
        mount: "secret",
        path: "config",
        retryInitialMs: 5,
        retryMaximumMs: 4
      })
    ).toThrow("retryMaximumMs")
    expect(() =>
      vaultSource({
        fetch,
        address: "https://vault.example",
        mount: "团队",
        path: "应用/😀"
      })
    ).not.toThrow()
  })

  test("returns frozen secret-safe HTTP, transport, and protocol failures", async () => {
    const token = "do-not-leak-token"
    const failures: Error[] = []
    const fetches: VaultFetch[] = [
      function syncFailure() {
        throw new Error(token)
      },
      function rejectedFetch() {
        return Promise.reject(new Error(token))
      },
      async function malformedResponse() {
        return JSON.parse("{}")
      },
      async function forbidden() {
        return new Response(token, { status: 403 })
      },
      async function invalidJson() {
        return new Response("not-json")
      }
    ]
    for (const fetch of fetches) {
      const source = vaultSource({
        fetch,
        address: "https://vault.example",
        mount: "secret",
        path: "config",
        token
      })
      const failure = await source.load(background()).catch((error: unknown) => error)
      if (!(failure instanceof Error)) throw new Error("Vault error expected")
      failures.push(failure)
      expect(Object.isFrozen(failure)).toBe(true)
      expect(JSON.stringify(failure)).not.toContain(token)
      expect(String(failure)).not.toContain(token)
    }
    expect(
      failures.map(function code(error) {
        return Object.getOwnPropertyDescriptor(error, "code")?.value
      })
    ).toEqual([
      "GO_LIKE_VAULT_TRANSPORT",
      "GO_LIKE_VAULT_TRANSPORT",
      "GO_LIKE_VAULT_PROTOCOL",
      "GO_LIKE_VAULT_HTTP",
      "GO_LIKE_VAULT_PROTOCOL"
    ])
    expect(failures[3]).toMatchObject({ status: 403 })
  })

  test("strictly validates every KV v2 response layer and ConfigValue boundary", async () => {
    const documents = [
      "null",
      "{}",
      '{"data":null}',
      '{"data":{"data":[],"metadata":{"version":1,"created_time":"2026-08-03T00:00:00Z"}}}',
      '{"data":{"data":{},"metadata":null}}',
      '{"data":{"data":{},"metadata":{"version":1}}}',
      '{"data":{"data":{},"metadata":{"version":1,"created_time":"not-a-time"}}}',
      '{"data":{"data":{},"metadata":{"version":0,"created_time":"2026-08-03T00:00:00Z"}}}',
      '{"data":{"data":{},"metadata":{"version":1.5,"created_time":"2026-08-03T00:00:00Z"}}}',
      '{"data":{"data":{},"metadata":{"version":"1","created_time":"2026-08-03T00:00:00Z"}}}',
      '{"data":{"data":{"__proto__":{}},"metadata":{"version":1,"created_time":"2026-08-03T00:00:00Z"}}}',
      '{"data":{"data":{"nested":{"constructor":1}},"metadata":{"version":1,"created_time":"2026-08-03T00:00:00Z"}}}',
      '{"data":{"data":{"value":[{"prototype":true}]},"metadata":{"version":1,"created_time":"2026-08-03T00:00:00Z"}}}'
    ]
    for (const document of documents) {
      const source = vaultSource({
        fetch: async function fetchVault() {
          return new Response(document)
        },
        address: "https://vault.example",
        mount: "secret",
        path: "config"
      })
      await expect(source.load(background())).rejects.toMatchObject({
        code: "GO_LIKE_VAULT_PROTOCOL"
      })
    }
  })

  test("classifies synchronous and asynchronous body failures as transport failures", async () => {
    const synchronous = new Proxy(new Response("{}"), {
      get(target, propertyKey, receiver) {
        if (propertyKey === "text") {
          return function text() {
            throw new Error("body sync failure")
          }
        }
        return Reflect.get(target, propertyKey, target)
      }
    })
    const asynchronous = new Proxy(new Response("{}"), {
      get(target, propertyKey, receiver) {
        if (propertyKey === "text") {
          return function text() {
            return Promise.reject(new Error("body async failure"))
          }
        }
        return Reflect.get(target, propertyKey, target)
      }
    })
    for (const response of [synchronous, asynchronous]) {
      const source = vaultSource({
        fetch: async function fetchVault() {
          return response
        },
        address: "https://vault.example",
        mount: "secret",
        path: "config"
      })
      await expect(source.load(background())).rejects.toMatchObject({
        code: "GO_LIKE_VAULT_TRANSPORT"
      })
    }
  })

  test("lets Context cancellation win non-cooperative Fetch and body reads", async () => {
    const immediateCancellation = new Error("fetch canceled before observation")
    const [immediateContext, cancelImmediate] = withCancelCause(background())
    const immediateSource = vaultSource({
      fetch: function fetchVault() {
        cancelImmediate(immediateCancellation)
        return Promise.resolve(kvResponse(1, {}))
      },
      address: "https://vault.example",
      mount: "secret",
      path: "config"
    })
    await expect(immediateSource.load(immediateContext)).rejects.toBe(immediateCancellation)

    const fetchGate = deferred<Response>()
    const fetchSource = vaultSource({
      fetch: function fetchVault() {
        return fetchGate.promise
      },
      address: "https://vault.example",
      mount: "secret",
      path: "config"
    })
    const fetchCancellation = new Error("fetch canceled")
    const [fetchContext, cancelFetch] = withCancelCause(background())
    const fetchLoad = fetchSource.load(fetchContext)
    await flush()
    cancelFetch(fetchCancellation)
    await expect(fetchLoad).rejects.toBe(fetchCancellation)
    fetchGate.resolve(kvResponse(1, {}))

    const stream = new ReadableStream<Uint8Array>({
      /** Leaves one successful response body pending until Request cancellation. */
      start() {}
    })
    const bodySource = vaultSource({
      fetch: async function fetchVault() {
        return new Response(stream)
      },
      address: "https://vault.example",
      mount: "secret",
      path: "config"
    })
    const bodyCancellation = new Error("body canceled")
    const [bodyContext, cancelBody] = withCancelCause(background())
    const bodyLoad = bodySource.load(bodyContext)
    await flush()
    cancelBody(bodyCancellation)
    await expect(bodyLoad).rejects.toBe(bodyCancellation)
  })

  test("keeps HTTP status authoritative when error body cancellation fails", async () => {
    const rejectingBody = new ReadableStream<Uint8Array>({
      /** Rejects best-effort body cancellation after HTTP classification. */
      cancel() {
        return Promise.reject(new Error("cancel rejected"))
      }
    })
    const throwingBody = new ReadableStream<Uint8Array>({
      /** Throws from best-effort body cancellation after HTTP classification. */
      cancel() {
        throw new Error("cancel threw")
      }
    })
    for (const body of [null, rejectingBody, throwingBody]) {
      const source = vaultSource({
        fetch: async function fetchVault() {
          return new Response(body, { status: 503 })
        },
        address: "https://vault.example",
        mount: "secret",
        path: "config"
      })
      await expect(source.load(background())).rejects.toMatchObject({
        code: "GO_LIKE_VAULT_HTTP",
        status: 503
      })
    }
    await flush()
  })
})

describe("Vault KV v2 polling watcher", () => {
  test("detects metadata deletion and recreation when the numeric version resets", async () => {
    const responses = [
      kvResponse(1, { release: 1 }, "2026-08-03T00:00:00.000000001Z"),
      kvResponse(1, { release: 1 }, "2026-08-03T00:00:00.000000001Z"),
      kvResponse(1, { release: 2 }, "2026-08-03T00:00:00.000000002Z")
    ]
    let calls = 0
    const source = vaultSource(
      validOptions(async function fetchVault() {
        const response = responses[calls]
        calls += 1
        if (response === undefined) throw new Error("unexpected poll")
        return response
      })
    )
    const initial = await source.load(background())
    if (source.watch === undefined) throw new Error("watch capability missing")
    const watch = await source.watch(background(), initial.revision)
    const [ctx, cancel] = withTimeout(background(), 100)
    try {
      await expect(watch.next(ctx)).resolves.toBeUndefined()
    } finally {
      cancel()
      await watch.stop(background())
    }
    expect(calls).toBe(3)
  })

  test("ignores unchanged versions and resolves only after a real version change", async () => {
    const responses = [
      kvResponse(1, { release: 1 }),
      kvResponse(1, { release: 1 }),
      kvResponse(2, { release: 2 })
    ]
    let calls = 0
    const watch = await watcher(
      validOptions(async function fetchVault() {
        const response = responses[calls]
        calls += 1
        if (response === undefined) throw new Error("unexpected poll")
        return response
      }),
      revisionToken(1)
    )
    const next = watch.next(background())
    await expect(watch.next(background())).rejects.toThrow("already waiting")
    await expect(next).resolves.toBeUndefined()
    expect(calls).toBe(3)
    await watch.stop(background())
    await expect(watch.next(background())).rejects.toThrow("has stopped")
    await expect(watch.stop(background())).resolves.toBeUndefined()
  })

  test("uses a null revision only as a silent polling baseline", async () => {
    const versions = [4, 4, 5]
    let calls = 0
    const watch = await watcher(
      validOptions(async function fetchVault() {
        const version = versions[calls]
        calls += 1
        if (version === undefined) throw new Error("unexpected poll")
        return kvResponse(version, { version })
      }),
      null
    )
    await expect(watch.next(background())).resolves.toBeUndefined()
    expect(calls).toBe(3)
    await watch.stop(background())
  })

  test("accepts a legacy decimal revision only to force one safe resync", async () => {
    let calls = 0
    const watch = await watcher(
      validOptions(async function fetchVault() {
        calls += 1
        return kvResponse(1, { release: 1 })
      }),
      "1"
    )
    await expect(watch.next(background())).resolves.toBeUndefined()
    expect(calls).toBe(1)
    await watch.stop(background())
  })

  test("retries transport and retryable HTTP failures with a bounded delay", async () => {
    const outcomes = ["transport", 404, 408, 425, 429, 500, 2]
    let calls = 0
    const watch = await watcher(
      validOptions(async function fetchVault() {
        const outcome = outcomes[calls]
        calls += 1
        if (outcome === "transport") throw new Error("network down")
        if (typeof outcome !== "number") throw new Error("unexpected retry outcome")
        return outcome < 100
          ? kvResponse(outcome, { release: outcome })
          : new Response(null, { status: outcome })
      }),
      "1"
    )
    await expect(watch.next(background())).resolves.toBeUndefined()
    expect(calls).toBe(outcomes.length)
    await watch.stop(background())
  })

  test("terminates on authorization and protocol failures", async () => {
    const responses = [new Response(null, { status: 403 }), new Response("not-json")]
    for (const response of responses) {
      const watch = await watcher(
        validOptions(async function fetchVault() {
          return response
        }),
        "1"
      )
      const failure = await watch.next(background()).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({
        code: response.status === 403 ? "GO_LIKE_VAULT_HTTP" : "GO_LIKE_VAULT_PROTOCOL"
      })
      await watch.stop(background())
    }
  })

  test("preserves exact caller cancellation and lets a canceled stop caller leave", async () => {
    let calls = 0
    const watch = await watcher(
      validOptions(async function fetchVault() {
        calls += 1
        return kvResponse(1, {})
      }),
      "1"
    )
    const before = new Error("before next")
    const [beforeContext, cancelBefore] = withCancelCause(background())
    cancelBefore(before)
    await expect(watch.next(beforeContext)).rejects.toBe(before)
    expect(calls).toBe(0)

    const during = new Error("during interval")
    const [duringContext, cancelDuring] = withCancelCause(background())
    const pending = watch.next(duringContext)
    cancelDuring(during)
    await expect(pending).rejects.toBe(during)

    const stopCancellation = new Error("stop waiter canceled")
    const [stopContext, cancelStop] = withCancelCause(background())
    cancelStop(stopCancellation)
    await expect(watch.stop(stopContext)).rejects.toBe(stopCancellation)
    await expect(watch.stop(background())).resolves.toBeUndefined()
  })

  test("rejects malformed revisions and canceled watch admission", async () => {
    const source = vaultSource(
      validOptions(async function fetchVault() {
        return kvResponse(1, {})
      })
    )
    if (source.watch === undefined) throw new Error("watch capability missing")
    for (const revision of [
      "",
      "0",
      "-1",
      "1.0",
      "x",
      "[]",
      JSON.stringify([2, 1, "2026-08-03T00:00:00Z"]),
      JSON.stringify([1, 1, "not-a-time"])
    ]) {
      await expect(source.watch(background(), revision)).rejects.toThrow("valid opaque token")
    }
    const cancellation = new Error("watch admission canceled")
    const [ctx, cancel] = withCancelCause(background())
    cancel(cancellation)
    await expect(source.watch(ctx, "1")).rejects.toBe(cancellation)
  })

  test("stop aborts and drains one non-cooperative active Fetch", async () => {
    const gate = deferred<Response>()
    const watch = await watcher(
      validOptions(function fetchVault() {
        return gate.promise
      }),
      "1"
    )
    const next = watch.next(background())
    await waitUntil(function requestStarted() {
      return true
    }, 10)
    const stopping = watch.stop(background())
    await expect(next).rejects.toThrow("has stopped")
    await expect(stopping).resolves.toBeUndefined()
    gate.resolve(kvResponse(2, {}))
  })

  test("keeps Config last-good through outage and publishes after recovery", async () => {
    let outage = false
    let version = 1
    let fetches = 0
    const source = vaultSource({
      fetch: async function fetchVault() {
        fetches += 1
        return outage
          ? new Response(null, { status: 503 })
          : kvResponse(version, { release: version })
      },
      address: "https://vault.example",
      mount: "secret",
      path: "config",
      pollIntervalMs: 1,
      retryInitialMs: 1,
      retryMaximumMs: 2
    })
    const config = newConfig(configSource(source))
    const running = config.load(background())
    const release = config.value("release")
    while (release.load() === null) await Bun.sleep(1)
    const initial = release.load()
    outage = true
    await waitUntil(function observedOutage() {
      return fetches >= 4
    })
    expect(release.load()).toBe(initial)
    version = 2
    outage = false
    await waitUntil(function recovered() {
      return release.load() === 2
    })
    expect(release.load()).not.toBe(initial)
    await config.close(background())
    await running
  })
})
