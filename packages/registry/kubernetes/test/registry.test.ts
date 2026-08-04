import {
  background,
  deadlineExceeded,
  type Context,
  withCancelCause,
  withTimeout
} from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { expect, test } from "bun:test"

import { encodeCandidate, encodeSlice } from "../src/codec"
import { newKubernetesRegistry, type KubernetesFetch } from "../src/index"
import { fakeKubernetes, type FakeKubernetes } from "./helpers"

const MaximumWatchFrameBytes = 1_048_576
const Encoder = new TextEncoder()

/** Creates one deterministic public instance revision. */
function instance(revision: string, name = "orders"): ServiceInstance {
  return {
    id: "orders-1",
    name,
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "updated" ? "http://10.42.0.10:8081/" : "http://10.42.0.10:8080/"]
  }
}

/** Creates one fast provider connected to a selected fake API server. */
function registry(api: FakeKubernetes, timeoutMs = 5_000) {
  return newKubernetesRegistry({
    fetch: api.fetch,
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4,
    watchTimeoutSeconds: 5,
    timeoutMs
  })
}

/** Builds one valid bookmark frame padded to an exact raw UTF-8 payload byte length. */
function sizedBookmarkFrame(byteLength: number): Uint8Array {
  const prefix = Encoder.encode(
    JSON.stringify({
      type: "BOOKMARK",
      object: { metadata: { resourceVersion: "1" } },
      padding: "猫".repeat(200_000)
    })
  )
  if (prefix.byteLength > byteLength) throw new Error("bookmark frame fixture exceeds its target")
  const frame = new Uint8Array(byteLength + 1)
  frame.set(prefix)
  frame.fill(0x20, prefix.byteLength, byteLength)
  frame[byteLength] = 0x0a
  return frame
}

test("register, replace, discover, stale-deregister, and exact deregister use one deterministic slice", async () => {
  const api = fakeKubernetes()
  const value = registry(api, 321)
  const initial = instance("initial")
  const updated = instance("updated")

  api.failNext("POST", 409)
  expect(await value.register(background(), initial)).toBeUndefined()
  const names = api.names()
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^go-like-[a-z2-7]{52}$/)
  expect(await value.getService(background(), "orders")).toEqual([initial])

  expect(await value.register(background(), updated)).toBeUndefined()
  expect(api.names()).toEqual(names)
  expect(await value.getService(background(), "orders")).toEqual([updated])

  await value.deregister(background(), initial)
  expect(await value.getService(background(), "orders")).toEqual([updated])
  api.failNext("DELETE", 409)
  expect(await value.deregister(background(), updated)).toBeUndefined()
  expect(await value.deregister(background(), updated)).toBeUndefined()
  expect(api.names()).toEqual([])

  expect(Object.keys(value).sort()).toEqual(["deregister", "getService", "register", "watch"])
  expect("capabilities" in value).toBe(false)
  expect(Object.isFrozen(value)).toBe(true)
})

test("stale deregister cannot delete an identical instance taken over by another Pod", async () => {
  const api = fakeKubernetes()
  const common = {
    fetch: api.fetch,
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4
  } as const
  const first = newKubernetesRegistry({
    ...common,
    owner: { name: "orders-a", uid: "uid-a" }
  })
  const second = newKubernetesRegistry({
    ...common,
    owner: { name: "orders-b", uid: "uid-b" }
  })
  const unowned = newKubernetesRegistry(common)
  const initial = instance("initial")

  await first.register(background(), initial)
  await second.register(background(), initial)
  await first.deregister(background(), initial)
  await unowned.deregister(background(), initial)
  expect(await first.getService(background(), initial.name)).toEqual([initial])
  await second.deregister(background(), initial)
  expect(await first.getService(background(), initial.name)).toEqual([])
})

test("registration rejects foreign collision and malformed input before mutation", async () => {
  const api = fakeKubernetes()
  const value = registry(api)
  const candidate = await encodeCandidate(instance("initial"))
  api.putForeign(candidate.name)
  await expect(value.register(background(), instance("initial"))).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
  expect(api.object(candidate.name)).not.toBeNull()
  await expect(value.deregister(background(), instance("initial"))).resolves.toBeUndefined()
  expect(api.object(candidate.name)).not.toBeNull()

  const before = api.requests.length
  await expect(
    value.register(background(), {
      ...instance("initial"),
      endpoints: ["not an absolute URL"]
    })
  ).rejects.toBeInstanceOf(TypeError)
  expect(api.requests).toHaveLength(before)
})

test("registration rejects a valid readback for a different instance revision", async () => {
  const api = fakeKubernetes()
  const wrong = await encodeCandidate(instance("updated"))
  const wrongWire = JSON.parse(encodeSlice(wrong, "go-like-test", null)) as Record<string, unknown>
  const wrongMetadata = wrongWire.metadata as Record<string, unknown>
  wrongMetadata.resourceVersion = "99"
  const value = newKubernetesRegistry({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST") return Response.json(wrongWire, { status: 201 })
      return api.fetch(request)
    },
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4
  })
  await expect(value.register(background(), instance("initial"))).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })

  const ownerApi = fakeKubernetes()
  const strippedOwner = newKubernetesRegistry({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const response = await ownerApi.fetch(request)
      if (request.method !== "POST" || response.status !== 201) return response
      const body = (await response.json()) as Record<string, unknown>
      const metadata = body.metadata as Record<string, unknown>
      delete metadata.ownerReferences
      return Response.json(body, { status: 201 })
    },
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    owner: { name: "orders-pod", uid: "pod-uid" }
  })
  await expect(strippedOwner.register(background(), instance("initial"))).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
})

test("watch returns complete replacement snapshots and owns only next/stop", async () => {
  const api = fakeKubernetes()
  const value = registry(api)
  api.staleNextWatch()
  const watcher = await value.watch(background(), "orders")
  expect(Object.keys(watcher).sort()).toEqual(["next", "stop"])

  const initial = instance("initial")
  await value.register(background(), initial)
  expect(await watcher.next(withTimeout(background(), 1_000)[0])).toEqual([initial])

  const updated = instance("updated")
  await value.register(background(), updated)
  expect(await watcher.next(withTimeout(background(), 1_000)[0])).toEqual([updated])

  api.sendWatchFrame({ type: "BOOKMARK", object: {} })
  api.closeWatches()
  await Bun.sleep(0)
  await value.deregister(background(), updated)
  expect(await watcher.next(withTimeout(background(), 1_000)[0])).toEqual([])

  const [nextContext, cancelNext] = withCancelCause(background())
  const waiting = watcher.next(nextContext)
  const nextFailure = new Error("next canceled")
  cancelNext(nextFailure)
  await expect(waiting).rejects.toBe(nextFailure)

  const pending = watcher.next(background())
  let pendingFailure: unknown
  const observedPending = pending.catch((error: unknown) => {
    pendingFailure = error
  })
  await expect(watcher.stop(background())).resolves.toBeUndefined()
  await observedPending
  expect(pendingFailure).toMatchObject({ code: "GO_LIKE_WATCHER_STOPPED" })
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_WATCHER_STOPPED"
  })
  await expect(watcher.stop(background())).resolves.toBeUndefined()
})

test("watch emits an existing snapshot and fails closed on malformed frames and overflow", async () => {
  const api = fakeKubernetes()
  const value = registry(api)
  const initial = instance("initial")
  await value.register(background(), initial)
  const existing = await value.watch(background(), "orders")
  expect(await existing.next(background())).toEqual([initial])
  await existing.stop(background())

  const malformed = await value.watch(background(), "orders")
  await malformed.next(background())
  api.sendWatchFrame({ type: "UNKNOWN", object: {} })
  await expect(malformed.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
  await malformed.stop(background())

  const overflowValue = newKubernetesRegistry({
    fetch: api.fetch,
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4,
    watchTimeoutSeconds: 5,
    watchBufferSize: 1
  })
  const overflow = await overflowValue.watch(background(), "orders")
  await overflow.next(background())
  await overflowValue.register(background(), instance("updated"))
  await overflowValue.deregister(background(), instance("updated"))
  await Bun.sleep(10)
  await expect(overflow.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_WATCHER_OVERFLOW",
    bufferSize: 1
  })
  await overflow.stop(background())
})

test("watch frame syntax, shape, revision, status, and UTF-8 errors fail closed", async () => {
  const malformedFrames: readonly {
    readonly bytes: Uint8Array
    readonly close: boolean
  }[] = [
    { bytes: new TextEncoder().encode("{\n"), close: false },
    { bytes: new TextEncoder().encode("null\n"), close: false },
    {
      bytes: new TextEncoder().encode(
        `${JSON.stringify({
          type: "BOOKMARK",
          object: { metadata: { resourceVersion: 1 } }
        })}\n`
      ),
      close: false
    },
    {
      bytes: new TextEncoder().encode(
        `${JSON.stringify({
          type: "ERROR",
          object: { apiVersion: "v1", kind: "Status", code: 400 }
        })}\n`
      ),
      close: false
    },
    { bytes: Uint8Array.of(0xff), close: false },
    { bytes: Uint8Array.of(0xe2), close: true }
  ]

  for (const malformed of malformedFrames) {
    const api = fakeKubernetes()
    const watcher = await registry(api).watch(background(), "orders")
    const failure = watcher.next(background()).catch((error: unknown) => error)
    api.sendWatchBytes(malformed.bytes)
    if (malformed.close) api.closeWatches()
    expect(await failure).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
    await watcher.stop(background())
  }
})

test("watch bookmarks, blank lines, and expired revisions recover without partial events", async () => {
  const bookmarkApi = fakeKubernetes()
  const bookmarkRegistry = registry(bookmarkApi)
  const bookmarkWatcher = await bookmarkRegistry.watch(background(), "orders")
  const bookmarkNext = bookmarkWatcher.next(withTimeout(background(), 1_000)[0])
  bookmarkApi.sendWatchBytes(new TextEncoder().encode("\n"))
  bookmarkApi.sendWatchBytes(new TextEncoder().encode('{"type":"BOOKMARK","object":{"metadata":'))
  bookmarkApi.sendWatchBytes(new TextEncoder().encode('{"resourceVersion":"1"}}}\n'))
  const bookmarked = instance("bookmarked")
  await bookmarkRegistry.register(background(), bookmarked)
  expect(await bookmarkNext).toEqual([bookmarked])
  await bookmarkWatcher.stop(background())

  const staleApi = fakeKubernetes()
  const staleRegistry = registry(staleApi)
  const staleWatcher = await staleRegistry.watch(background(), "orders")
  const staleNext = staleWatcher.next(withTimeout(background(), 1_000)[0])
  staleApi.sendWatchFrame({
    type: "ERROR",
    object: { apiVersion: "v1", kind: "Status", code: 410 }
  })
  const recovered = instance("recovered")
  await staleRegistry.register(background(), recovered)
  expect(await staleNext).toEqual([recovered])
  await staleWatcher.stop(background())
})

test("watch retries a failed event relist without skipping the event revision", async () => {
  const api = fakeKubernetes()
  let failRelist = false
  let failedRelists = 0
  const value = newKubernetesRegistry({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (
        failRelist &&
        request.method === "GET" &&
        url.searchParams.get("watch") !== "true" &&
        url.pathname.endsWith("/endpointslices")
      ) {
        failRelist = false
        failedRelists += 1
        return Response.json(
          { apiVersion: "v1", kind: "Status", status: "Failure", code: 503 },
          { status: 503 }
        )
      }
      return api.fetch(request)
    },
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4
  })
  const watcher = await value.watch(background(), "orders")
  const changed = instance("relisted")
  try {
    failRelist = true
    await value.register(background(), changed)
    expect(await watcher.next(withTimeout(background(), 100)[0])).toEqual([changed])
    expect(failedRelists).toBe(1)
    const cursors = api.requests
      .filter((request) => new URL(request.url).searchParams.get("watch") === "true")
      .map((request) => new URL(request.url).searchParams.get("resourceVersion"))
    expect(cursors).toEqual(["1", "1"])
  } finally {
    await watcher.stop(background())
    await value.deregister(background(), changed)
  }
})

test("watch admits one exact 1 MiB frame measured by raw UTF-8 bytes", async () => {
  const api = fakeKubernetes()
  const value = registry(api)
  const watcher = await value.watch(background(), "orders")
  const changed = instance("boundary")
  try {
    const waiting = watcher.next(withTimeout(background(), 1_000)[0])
    const frame = sizedBookmarkFrame(MaximumWatchFrameBytes)
    api.sendWatchBytes(frame.slice(0, 524_287))
    api.sendWatchBytes(frame.slice(524_287))
    await value.register(background(), changed)
    expect(await waiting).toEqual([changed])
  } finally {
    await watcher.stop(background())
    await value.deregister(background(), changed)
  }
})

test("watch counts an initial UTF-8 BOM toward the raw byte limit", async () => {
  const api = fakeKubernetes()
  const watcher = await registry(api).watch(background(), "orders")
  const observed = watcher.next(background()).catch((error: unknown) => error)
  const frame = sizedBookmarkFrame(MaximumWatchFrameBytes)
  const bytes = new Uint8Array(frame.byteLength + 3)
  bytes.set([0xef, 0xbb, 0xbf])
  bytes.set(frame, 3)
  api.sendWatchBytes(bytes)
  const outcome = await Promise.race([
    observed,
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => null)
  ])
  await watcher.stop(background())
  await observed
  expect(outcome).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("watch rejects a chunked frame above the 1 MiB raw byte limit", async () => {
  const api = fakeKubernetes()
  const watcher = await registry(api).watch(background(), "orders")
  const observed = watcher.next(background()).catch((error: unknown) => error)
  const frame = sizedBookmarkFrame(MaximumWatchFrameBytes + 1)
  api.sendWatchBytes(frame.slice(0, 524_287))
  api.sendWatchBytes(frame.slice(524_287))
  const outcome = await Promise.race([
    observed,
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => null)
  ])
  await watcher.stop(background())
  await observed
  expect(outcome).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("watch rejects a partial frame as soon as its raw bytes exceed 1 MiB", async () => {
  const api = fakeKubernetes()
  const watcher = await registry(api).watch(background(), "orders")
  const observed = watcher.next(background()).catch((error: unknown) => error)
  const frame = sizedBookmarkFrame(MaximumWatchFrameBytes + 1)
  api.sendWatchBytes(frame.slice(0, 524_287))
  api.sendWatchBytes(frame.slice(524_287, -1))
  const outcome = await Promise.race([
    observed,
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => null)
  ])
  await watcher.stop(background())
  await observed
  expect(outcome).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("watch tolerates reader cancellation failure and aborts a retry wait on stop", async () => {
  const cancelApi = fakeKubernetes()
  let firstWatch = true
  const stream = {
    controller: null as ReadableStreamDefaultController<Uint8Array> | null
  }
  const cancelRegistry = newKubernetesRegistry({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (firstWatch && url.searchParams.get("watch") === "true") {
        firstWatch = false
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              stream.controller = controller
            },
            cancel(): void {
              throw new Error("injected reader cancellation failure")
            }
          }),
          { status: 200 }
        )
      }
      return cancelApi.fetch(request)
    },
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4
  })
  const cancelWatcher = await cancelRegistry.watch(background(), "orders")
  const cancelNext = cancelWatcher.next(withTimeout(background(), 1_000)[0])
  const registered = instance("cancel-reader")
  await cancelRegistry.register(background(), registered)
  stream.controller?.enqueue(
    new TextEncoder().encode(
      `${JSON.stringify({
        type: "ADDED",
        object: { metadata: { resourceVersion: "2" } }
      })}\n`
    )
  )
  expect(await cancelNext).toEqual([registered])
  await cancelWatcher.stop(background())

  const retryApi = fakeKubernetes()
  let watchRequests = 0
  let retryStarted: () => void = () => {}
  const retryAdmission = new Promise<void>((resolve) => {
    retryStarted = resolve
  })
  const retryRegistry = newKubernetesRegistry({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.searchParams.get("watch") === "true") {
        watchRequests += 1
        if (watchRequests > 1) {
          retryStarted()
          return Response.json(
            { apiVersion: "v1", kind: "Status", status: "Failure", code: 503 },
            { status: 503 }
          )
        }
      }
      return retryApi.fetch(request)
    },
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 100,
    retryMaximumMs: 100
  })
  const retryWatcher = await retryRegistry.watch(background(), "orders")
  retryApi.closeWatches()
  await retryAdmission
  await Bun.sleep(1)
  await retryWatcher.stop(background())
})

test("discovery validates names and normalizes get and watch admission failures", async () => {
  const value = registry(fakeKubernetes())
  await expect(value.getService(background(), "")).rejects.toBeInstanceOf(TypeError)
  await expect(value.watch(background(), "")).rejects.toBeInstanceOf(TypeError)

  const denied = newKubernetesRegistry({
    fetch: async () =>
      Response.json(
        { apiVersion: "v1", kind: "Status", status: "Failure", code: 403 },
        { status: 403 }
      ),
    address: "https://kubernetes.example",
    namespace: "go-like-test"
  })
  await expect(denied.getService(background(), "orders")).rejects.toMatchObject({
    code: "GO_LIKE_KUBERNETES_HTTP",
    status: 403
  })
  await expect(denied.watch(background(), "orders")).rejects.toMatchObject({
    code: "GO_LIKE_KUBERNETES_HTTP",
    status: 403
  })
})

test("watch admission closes an admitted stream when its caller cancels concurrently", async () => {
  const api = fakeKubernetes()
  const failure = new Error("admission caller canceled")
  let cancelAdmission: () => void = () => {}
  const value = newKubernetesRegistry({
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.searchParams.get("watch") === "true") cancelAdmission()
      return api.fetch(request)
    },
    address: "https://kubernetes.example",
    namespace: "go-like-test"
  })
  const [ctx, cancel] = withCancelCause(background())
  cancelAdmission = () => cancel(failure)
  await expect(value.watch(ctx, "orders")).rejects.toBe(failure)
})

test("watch closes a fully admitted watcher when final Context inspection fails", async () => {
  const value = registry(fakeKubernetes())
  const failure = new Error("final admission inspection failed")
  let inspections = 0
  const staged: Context = {
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal | null {
      return null
    },
    err(): Error | null {
      inspections += 1
      return inspections >= 3 ? failure : null
    },
    value(): unknown {
      return null
    }
  }
  await expect(value.watch(staged, "orders")).rejects.toBe(failure)
})

test("caller cancellation aborts the exact standard Fetch request", async () => {
  let started: () => void = () => {}
  const admission = new Promise<void>((resolve) => {
    started = resolve
  })
  const fetch: KubernetesFetch = async function held(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    started()
    return new Promise<Response>(
      /** Rejects with the exact Request AbortSignal reason. */
      function wait(_resolve, reject): void {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true
        })
      }
    )
  }
  const value = newKubernetesRegistry({
    fetch,
    address: "https://kubernetes.example",
    namespace: "go-like-test"
  })
  const [ctx, cancel] = withCancelCause(background())
  const failure = new Error("caller canceled")
  const operation = value.getService(ctx, "orders")
  await admission
  cancel(failure)
  await expect(operation).rejects.toBe(failure)
})

test("watch admission links caller cancellation and its common timeout", async () => {
  /** Creates one API whose initial list completes before watch admission remains pending. */
  function heldWatchApi(admitted: () => void, api = fakeKubernetes()): KubernetesFetch {
    return async function held(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.searchParams.get("watch") !== "true") return api.fetch(request)
      admitted()
      return new Promise<Response>(
        /** Rejects when the provider aborts the admission Request. */
        function pending(_resolve, reject): void {
          /** Preserves the exact AbortSignal reason. */
          function aborted(): void {
            reject(request.signal.reason)
          }
          if (request.signal.aborted) aborted()
          else request.signal.addEventListener("abort", aborted, { once: true })
        }
      )
    }
  }

  let cancelAdmitted: () => void = () => {}
  const cancelAdmission = new Promise<void>((resolve) => {
    cancelAdmitted = resolve
  })
  const canceled = newKubernetesRegistry({
    fetch: heldWatchApi(cancelAdmitted),
    address: "https://kubernetes.example",
    namespace: "go-like-test"
  })
  const [ctx, cancel] = withCancelCause(background())
  const cancelFailure = new Error("watch admission canceled")
  const canceledWatch = canceled.watch(ctx, "orders")
  await cancelAdmission
  cancel(cancelFailure)
  await expect(canceledWatch).rejects.toBe(cancelFailure)

  let timeoutAdmitted: () => void = () => {}
  const timeoutAdmission = new Promise<void>((resolve) => {
    timeoutAdmitted = resolve
  })
  const timed = newKubernetesRegistry({
    fetch: heldWatchApi(timeoutAdmitted),
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    timeoutMs: 1
  })
  const timedWatch = timed.watch(background(), "orders")
  await timeoutAdmission
  await expect(timedWatch).rejects.toBe(deadlineExceeded)
})
