import { background, withCancelCause } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { expect, test } from "bun:test"

import { newEtcdRegistry, type EtcdFetch } from "../src/index"
import { eventually, fakeEtcd } from "./helpers"

const MaximumWatchFrameBytes = 1_048_576
const Encoder = new TextEncoder()

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: {},
  endpoints: ["http://127.0.0.1:8080/"]
}

/** Returns one empty consistent range response. */
function emptyRange(): Response {
  return Response.json({ header: { revision: "1" }, kvs: [], count: "0" })
}

/** Creates one resident watch response from exact byte chunks. */
function watchResponse(
  chunks: readonly Uint8Array[],
  close: boolean,
  failCancel = false
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk)
        if (close) controller.close()
      },
      cancel(): void {
        if (failCancel) throw new Error("injected body cancel failure")
      }
    })
  )
}

/** Encodes one newline-delimited etcd watch result. */
function frame(result: object, newline = true): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ result })}${newline ? "\n" : ""}`)
}

/** Builds one valid creation frame padded to an exact raw UTF-8 payload byte length. */
function sizedCreationFrame(byteLength: number): Uint8Array {
  const prefix = Encoder.encode(
    JSON.stringify({
      result: { created: true, header: { revision: "1" } },
      padding: "猫".repeat(200_000)
    })
  )
  if (prefix.byteLength > byteLength) throw new Error("creation frame fixture exceeds its target")
  const value = new Uint8Array(byteLength + 1)
  value.set(prefix)
  value.fill(0x20, prefix.byteLength, byteLength)
  value[byteLength] = 0x0a
  return value
}

/** Creates a short-retry Registry around one exact watch response factory. */
function registryWithWatch(factory: (request: Request) => Response): {
  readonly registry: ReturnType<typeof newEtcdRegistry>
  readonly watchCalls: () => number
} {
  let calls = 0
  const fetch: EtcdFetch = async function watchFetch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/v3/kv/range") return emptyRange()
    calls += 1
    return factory(request)
  }
  return {
    registry: newEtcdRegistry({
      fetch,
      address: "https://etcd.example",
      retryInitialMs: 2,
      retryMaximumMs: 2
    }),
    watchCalls(): number {
      return calls
    }
  }
}

test("query and watch boundaries reject empty service names", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  await expect(registry.getService(background(), "")).rejects.toThrow("non-empty")
  await expect(registry.watch(background(), "")).rejects.toThrow("non-empty")
})

test("caller cancellation abandons one next wait without stopping the watcher", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  const watcher = await registry.watch(background(), "orders")
  const [ctx, cancel] = withCancelCause(background())
  const failure = new Error("caller canceled")
  const pending = watcher.next(ctx)
  cancel(failure)
  await expect(pending).rejects.toBe(failure)
  await registry.register(background(), instance)
  expect(await watcher.next(background())).toEqual([instance])
  await registry.deregister(background(), instance)
  await watcher.stop(background())
})

test("stop aborts one pending wait and remains idempotent", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  const watcher = await registry.watch(background(), "orders")
  const pending = watcher.next(background())
  await watcher.stop(background())
  await expect(pending).rejects.toMatchObject({ code: "GO_LIKE_WATCHER_STOPPED" })
  await watcher.stop(background())
})

test("replacement watcher fails closed when its bounded queue overflows", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({
    fetch: etcd.fetch,
    address: "https://etcd.example",
    watchBufferSize: 1
  })
  const watcher = await registry.watch(background(), "orders")
  await registry.register(background(), instance)
  await eventually(
    () =>
      etcd.requests.filter(function range(request) {
        return new URL(request.url).pathname === "/v3/kv/range"
      }).length >= 2
  )
  const updated = {
    ...instance,
    endpoints: ["http://127.0.0.1:8081/"]
  }
  await registry.register(background(), updated)
  await eventually(
    () =>
      etcd.requests.filter(function range(request) {
        return new URL(request.url).pathname === "/v3/kv/range"
      }).length >= 3
  )
  await Bun.sleep(20)
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_WATCHER_OVERFLOW"
  })
  await watcher.stop(background())
  await registry.deregister(background(), updated)
})

test("resident watch protocol corruption rejects pending next", async () => {
  let watches = 0
  const fetch: EtcdFetch = async function fetch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path === "/v3/kv/range") {
      return Response.json({ header: { revision: "1" }, kvs: [], count: "0" })
    }
    if (path !== "/v3/watch") return new Response(null, { status: 404 })
    watches += 1
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("not-json\n"))
          controller.close()
        }
      })
    )
  }
  const registry = newEtcdRegistry({
    fetch,
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 2
  })
  const watcher = await registry.watch(background(), "orders")
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
  expect(watches).toBe(1)
  await watcher.stop(background())
})

test("resident watch connection admission obeys the common timeout", async () => {
  let timedOut = false
  const fetch: EtcdFetch = async function fetch(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/v3/kv/range") {
      return Response.json({ header: { revision: "1" }, kvs: [], count: "0" })
    }
    return await new Promise<Response>(function wait(_resolve, reject): void {
      request.signal.addEventListener(
        "abort",
        function aborted(): void {
          timedOut = true
          reject(request.signal.reason)
        },
        { once: true }
      )
    })
  }
  const registry = newEtcdRegistry({
    fetch,
    address: "https://etcd.example",
    retryInitialMs: 1_000,
    retryMaximumMs: 1_000,
    timeoutMs: 5
  })
  const watcher = await registry.watch(background(), "orders")
  await eventually(() => timedOut)
  await watcher.stop(background())
})

test("resident watch rejects malformed frame carriers and cancellation states", async () => {
  const cases: readonly [string, Uint8Array][] = [
    ["envelope", new TextEncoder().encode("[]\n")],
    ["revision", frame({ created: true, header: { revision: "invalid" } })],
    ["events", frame({ created: true, events: {} })],
    ["creation", frame({ header: { revision: "1" } })],
    ["cancellation", frame({ canceled: true })]
  ]
  for (const [, bytes] of cases) {
    const value = registryWithWatch(() => watchResponse([bytes], true))
    const watcher = await value.registry.watch(background(), "orders")
    await expect(watcher.next(background())).rejects.toMatchObject({
      code: "GO_LIKE_REGISTRY_PROTOCOL"
    })
    expect(value.watchCalls()).toBe(1)
    await watcher.stop(background())
  }
})

test("resident watch rejects invalid UTF-8 and post-creation cancellation without compaction", async () => {
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0xe2)]) {
    const invalidUtf8 = registryWithWatch(() => watchResponse([bytes], true))
    const invalidWatcher = await invalidUtf8.registry.watch(background(), "orders")
    await expect(invalidWatcher.next(background())).rejects.toMatchObject({
      code: "GO_LIKE_REGISTRY_PROTOCOL"
    })
    await invalidWatcher.stop(background())
  }

  const canceled = registryWithWatch(() =>
    watchResponse([frame({ created: true }), frame({ canceled: true })], true)
  )
  const canceledWatcher = await canceled.registry.watch(background(), "orders")
  await expect(canceledWatcher.next(background())).rejects.toThrow("canceled without compaction")
  await canceledWatcher.stop(background())
})

test("resident watch accepts a final non-newline frame and retries clean early EOF", async () => {
  const tail = registryWithWatch(() =>
    watchResponse([frame({ created: true, header: { revision: "1" } }, false)], true)
  )
  const tailWatcher = await tail.registry.watch(background(), "orders")
  await eventually(() => tail.watchCalls() >= 2)
  await tailWatcher.stop(background())

  const empty = registryWithWatch(() => watchResponse([], true))
  const emptyWatcher = await empty.registry.watch(background(), "orders")
  await eventually(() => empty.watchCalls() >= 2)
  await emptyWatcher.stop(background())
})

test("resident watch admits one exact 1 MiB frame measured by raw UTF-8 bytes", async () => {
  const bytes = sizedCreationFrame(MaximumWatchFrameBytes)
  const value = registryWithWatch(() =>
    watchResponse([bytes.slice(0, 524_287), bytes.slice(524_287)], true)
  )
  const watcher = await value.registry.watch(background(), "orders")
  await eventually(() => value.watchCalls() >= 2)
  await watcher.stop(background())
})

test("resident watch counts an initial UTF-8 BOM toward the raw byte limit", async () => {
  const frame = sizedCreationFrame(MaximumWatchFrameBytes)
  const bytes = new Uint8Array(frame.byteLength + 3)
  bytes.set([0xef, 0xbb, 0xbf])
  bytes.set(frame, 3)
  const value = registryWithWatch(() => watchResponse([bytes], true))
  const watcher = await value.registry.watch(background(), "orders")
  const observed = watcher.next(background()).catch((error: unknown) => error)
  const outcome = await Promise.race([
    observed,
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => null)
  ])
  await watcher.stop(background())
  await observed
  expect(outcome).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("resident watch rejects a chunked frame above the 1 MiB raw byte limit", async () => {
  const bytes = sizedCreationFrame(MaximumWatchFrameBytes + 1)
  const value = registryWithWatch(() =>
    watchResponse([bytes.slice(0, 524_287), bytes.slice(524_287)], true)
  )
  const watcher = await value.registry.watch(background(), "orders")
  const observed = watcher.next(background()).catch((error: unknown) => error)
  const outcome = await Promise.race([
    observed,
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => null)
  ])
  await watcher.stop(background())
  await observed
  expect(outcome).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("resident watch rejects a partial frame as soon as its raw bytes exceed 1 MiB", async () => {
  const bytes = sizedCreationFrame(MaximumWatchFrameBytes + 1)
  const value = registryWithWatch(
    (request) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes.slice(0, 524_287))
            controller.enqueue(bytes.slice(524_287, -1))
            request.signal.addEventListener(
              "abort",
              function aborted(): void {
                controller.error(request.signal.reason)
              },
              { once: true }
            )
          }
        })
      )
  )
  const watcher = await value.registry.watch(background(), "orders")
  const observed = watcher.next(background()).catch((error: unknown) => error)
  const outcome = await Promise.race([
    observed,
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => null)
  ])
  await watcher.stop(background())
  await observed
  expect(outcome).toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
})

test("resident watch ignores body cancellation failure after a terminal frame error", async () => {
  const value = registryWithWatch(() =>
    watchResponse([frame({ created: true }), new TextEncoder().encode("not-json\n")], false, true)
  )
  const watcher = await value.registry.watch(background(), "orders")
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
  await watcher.stop(background())
})

test("watch stops an admitted owner when its caller cancels during range body consumption", async () => {
  const etcd = fakeEtcd()
  const caller = withCancelCause(background())
  const failure = new Error("watch caller left after range")
  let cancelAfterRange = true
  const registry = newEtcdRegistry({
    address: "https://etcd.example",
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const response = await etcd.fetch(request)
      if (new URL(request.url).pathname !== "/v3/kv/range" || !cancelAfterRange) {
        return response
      }
      cancelAfterRange = false
      const body = await response.text()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode(body))
            caller[1](failure)
            controller.close()
          }
        })
      )
    }
  })

  await expect(registry.watch(caller[0], "orders")).rejects.toBe(failure)
})
