import { expect, test } from "bun:test"
import { background } from "@go-like/context"

import { bunShutdownTimeout, hostname, port } from "../../src/bun"
import {
  bunRuntimeFrom,
  newBunServerWithRuntime,
  type BunRuntime,
  type BunServeOptions,
  type BunServerHandle
} from "../../src/bun-server"

/** Controllable stand-in for the Bun server handle used by the adapter. */
class FakeBunServer implements BunServerHandle {
  port: number | undefined = 4321
  pendingRequests = 0
  stopFailure: unknown = null
  readonly stops: boolean[] = []
  readonly stopped = Promise.withResolvers<void>()

  stop(closeActiveConnections?: boolean): Promise<void> {
    this.stops.push(closeActiveConnections === true)
    this.port = 0
    if (this.stopFailure !== null) {
      const failure = this.stopFailure
      this.stopFailure = null
      throw failure
    }
    return this.stopped.promise
  }
}

/** Controllable stand-in for the Bun global that records every serve call. */
class FakeBun implements BunRuntime {
  readonly server = new FakeBunServer()
  readonly serveCalls: BunServeOptions[] = []
  serveFailure: unknown = null

  serve(options: BunServeOptions): BunServerHandle {
    this.serveCalls.push(options)
    if (this.serveFailure !== null) throw this.serveFailure
    return this.server
  }
}

/** Returns the options of the only serve call, failing the test when binding did not happen once. */
function onlyServeCall(bun: FakeBun): BunServeOptions {
  const [options] = bun.serveCalls
  if (bun.serveCalls.length !== 1 || options === undefined) {
    throw new Error(`expected exactly one Bun.serve call, got ${bun.serveCalls.length}`)
  }
  return options
}

/** Builds a real Request whose url property is relative, as Bun reports for an unusable Host. */
function relativeRequest(): Request {
  const request = new Request("http://localhost/")
  Object.defineProperty(request, "url", { value: "/p" })
  return request
}

test("accepts only a Bun-shaped runtime object with a clear error otherwise", () => {
  expect(bunRuntimeFrom(Bun)).toBe(Bun)
  for (const candidate of [undefined, null, 1, "Bun", {}, { serve: "not callable" }]) {
    expect(() => bunRuntimeFrom(candidate)).toThrow("@go-like/web/bun requires the Bun runtime")
  }
})

test("construction is side-effect free and start binds once with the exact Bun.serve options", async () => {
  const bun = new FakeBun()
  const server = newBunServerWithRuntime(() => new Response(), bun, hostname("0.0.0.0"), port(9000))
  expect(bun.serveCalls).toHaveLength(0)
  expect(server.protocol()).toBe("http")

  const running = server.start(background())
  const options = onlyServeCall(bun)

  expect(Object.keys(options).sort()).toEqual([
    "development",
    "error",
    "fetch",
    "hostname",
    "id",
    "port",
    "reusePort"
  ])
  expect(options.hostname).toBe("0.0.0.0")
  expect(options.port).toBe(9000)
  expect(options.reusePort).toBe(false)
  expect(options.development).toBe(false)
  expect(options.id).toBeNull()
  await expect(server.endpoint(background())).resolves.toBe("http://0.0.0.0:4321/")
  expect(bun.serveCalls).toHaveLength(1)

  const stopping = server.stop(background())
  bun.server.stopped.resolve()
  await stopping
  await running
  await expect(server.endpoint(background())).rejects.toThrow("bun web server is not bound")
})

test("hands the exact one-argument Fetch ABI to the handler and returns its Response unchanged", () => {
  const bun = new FakeBun()
  const observed: { arguments: number; request: Request | null } = { arguments: -1, request: null }
  const response = new Response("same")
  const request = new Request("http://localhost/abi")
  const server = newBunServerWithRuntime(function handler(incoming) {
    observed.arguments = arguments.length
    observed.request = incoming
    return response
  }, bun)
  void server.start(background())

  const result: unknown = Reflect.apply(onlyServeCall(bun).fetch, undefined, [request, bun.server])

  expect(result).toBe(response)
  expect(observed.request).toBe(request)
  expect(observed.arguments).toBe(1)
})

test("passes an asynchronous Response through and surfaces handler rejections to Bun", async () => {
  const bun = new FakeBun()
  const response = new Response("later")
  const failure = new Error("rejected")
  let reject = false
  const server = newBunServerWithRuntime(
    () => (reject ? Promise.reject(failure) : Promise.resolve(response)),
    bun
  )
  void server.start(background())
  const options = onlyServeCall(bun)
  const request = new Request("http://localhost/async")

  await expect(Promise.resolve(options.fetch(request))).resolves.toBe(response)
  reject = true
  await expect(Promise.resolve(options.fetch(request))).rejects.toBe(failure)
})

test("answers 400 for a relative request URL without entering the handler", async () => {
  const bun = new FakeBun()
  let calls = 0
  const server = newBunServerWithRuntime(() => {
    calls += 1
    return new Response("unreachable")
  }, bun)
  void server.start(background())

  const response = await onlyServeCall(bun).fetch(relativeRequest())

  expect(response.status).toBe(400)
  expect(response.body).toBeNull()
  expect(calls).toBe(0)
})

const nonResponses: readonly (readonly [string, unknown])[] = [
  ["undefined", undefined],
  ["null", null],
  ["a plain object", { status: 200 }],
  ["a string", "text"]
]

for (const [label, value] of nonResponses) {
  test(`rejects ${label} instead of a Response so Bun answers through the error callback`, async () => {
    const bun = new FakeBun()
    const synchronous = newBunServerWithRuntime(() => value as never, bun)
    void synchronous.start(background())
    const request = new Request("http://localhost/value")

    await expect(Promise.resolve(onlyServeCall(bun).fetch(request))).rejects.toThrow(TypeError)

    const asynchronousBun = new FakeBun()
    const asynchronous = newBunServerWithRuntime(
      () => Promise.resolve(value as never),
      asynchronousBun
    )
    void asynchronous.start(background())

    await expect(Promise.resolve(onlyServeCall(asynchronousBun).fetch(request))).rejects.toThrow(
      TypeError
    )
  })
}

test("maps handler failures to empty-body statuses through the error callback", async () => {
  const bun = new FakeBun()
  const server = newBunServerWithRuntime(() => new Response(), bun)
  void server.start(background())
  const { error } = onlyServeCall(bun)
  const timeout = Object.assign(new Error("late"), { name: "TimeoutError" })

  const failed = error(new Error("boom"))
  const timedOut = error(timeout)

  expect([failed.status, timedOut.status]).toEqual([500, 504])
  expect([failed.body, timedOut.body]).toEqual([null, null])
})

test("maps drain to stop(false), force to stop(true), and terminal only to the stop promise", async () => {
  const bun = new FakeBun()
  const server = newBunServerWithRuntime(() => new Response(), bun, bunShutdownTimeout(0))
  const running = server.start(background())
  bun.server.pendingRequests = 3

  const stopping = server.stop(background())

  expect(bun.server.stops).toEqual([false, true])
  let settled = false
  void running.catch(() => {
    settled = true
  })
  await Bun.sleep(5)
  expect(settled).toBe(false)

  bun.server.stopped.resolve()
  await stopping
  await expect(running).rejects.toMatchObject({
    name: "BunServerForceCloseError",
    code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE",
    timeoutMs: 0,
    activeRequests: 3
  })
})

test("a rejected stop promise is the terminal failure", async () => {
  const bun = new FakeBun()
  const failure = new Error("stop failed")
  const server = newBunServerWithRuntime(() => new Response(), bun)
  const running = server.start(background())

  const stopping = server.stop(background())
  bun.server.stopped.reject(failure)
  await stopping

  await expect(running).rejects.toBe(failure)
  expect(bun.server.stops).toEqual([false])
})

test("a synchronous stop failure is admitted and escalated to force", async () => {
  const bun = new FakeBun()
  const failure = new Error("stop threw")
  bun.server.stopFailure = failure
  const server = newBunServerWithRuntime(() => new Response(), bun)
  const running = server.start(background())

  const stopping = server.stop(background())
  bun.server.stopped.resolve()
  await stopping

  expect(bun.server.stops).toEqual([false, true])
  await expect(running).rejects.toBe(failure)
})

test("a synchronous bind failure keeps the runtime error identity for start, endpoint, and stop", async () => {
  const bun = new FakeBun()
  const failure = Object.assign(new Error("address in use"), { code: "EADDRINUSE" })
  bun.serveFailure = failure
  const server = newBunServerWithRuntime(() => new Response(), bun)

  const starting = server.start(background())

  await expect(starting).rejects.toBe(failure)
  await expect(server.endpoint(background())).rejects.toBe(failure)
  await expect(server.stop(background())).rejects.toBe(failure)
  expect(bun.serveCalls).toHaveLength(1)
  expect(bun.server.stops).toEqual([])
})
