import { expect, test } from "bun:test"
import { background } from "@go-like/context"

import { denoShutdownTimeout, hostname, port, type DenoServerOption } from "../../src/deno"
import {
  denoRuntimeFrom,
  newDenoServerWithRuntime,
  type DenoServeOptions
} from "../../src/deno-server"
import { FakeDeno } from "../fixtures/fake-deno"

/** Lets queued promise reactions and zero-delay timers run. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** Awaits a rejection through ordinary promise reactions and returns its reason. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("promise unexpectedly fulfilled")
    },
    (error: unknown) => error
  )
}

/** Returns the options of the only serve call, failing the test when binding did not happen once. */
function onlyServeCall(deno: FakeDeno): DenoServeOptions {
  const [options] = deno.serveCalls
  if (deno.serveCalls.length !== 1 || options === undefined) {
    throw new Error(`expected exactly one Deno.serve call, got ${deno.serveCalls.length}`)
  }
  return options
}

/** Starts a server over the fake runtime and returns its pieces. */
function started(...options: readonly DenoServerOption[]) {
  const deno = new FakeDeno()
  const server = newDenoServerWithRuntime(() => new Response("ok"), deno, ...options)
  const running = server.start(background())
  return { deno, server, running }
}

test("accepts only a Deno-shaped runtime object with a clear error otherwise", () => {
  const deno = new FakeDeno()

  expect(denoRuntimeFrom(deno)).toBe(deno)
  for (const candidate of [undefined, null, 1, "Deno", {}, { serve: "not callable" }]) {
    expect(() => denoRuntimeFrom(candidate)).toThrow("@go-like/web/deno requires the Deno runtime")
  }
})

test("construction is side-effect free and start binds once with the exact Deno.serve options", async () => {
  const deno = new FakeDeno()
  const server = newDenoServerWithRuntime(
    () => new Response(),
    deno,
    hostname("0.0.0.0"),
    port(9000)
  )
  expect(deno.serveCalls).toHaveLength(0)
  expect(server.protocol()).toBe("http")

  const running = server.start(background())
  const options = onlyServeCall(deno)

  expect(Object.keys(options).sort()).toEqual(["hostname", "onError", "onListen", "port", "signal"])
  expect(options.hostname).toBe("0.0.0.0")
  expect(options.port).toBe(9000)
  expect(options.signal).toBeInstanceOf(AbortSignal)
  expect(options.signal.aborted).toBe(false)
  expect(options.onListen()).toBeUndefined()
  await expect(server.endpoint(background())).resolves.toBe("http://0.0.0.0:4321/")
  expect(deno.serveCalls).toHaveLength(1)

  await server.stop(background())
  await running
  await expect(server.endpoint(background())).rejects.toThrow("deno web server is not bound")
})

test("hands the exact one-argument Fetch ABI to the handler and returns its Response unchanged", () => {
  const deno = new FakeDeno()
  const observed: { arguments: number; request: Request | null } = { arguments: -1, request: null }
  const response = new Response("same")
  const server = newDenoServerWithRuntime(function handler(incoming) {
    observed.arguments = arguments.length
    observed.request = incoming
    return response
  }, deno)
  void server.start(background())

  const delivered = deno.request("http://localhost/abi")

  expect(delivered.result).toBe(response)
  expect(observed.request).toBeInstanceOf(Request)
  expect(observed.arguments).toBe(1)
})

test("maps handler failures to empty-body statuses through onError", () => {
  const { deno } = started()
  const { onError } = onlyServeCall(deno)
  const timeout = Object.assign(new Error("late"), { name: "TimeoutError" })

  const failed = onError(new Error("boom"))
  const timedOut = onError(timeout)

  expect([failed.status, timedOut.status]).toEqual([500, 504])
  expect([failed.body, timedOut.body]).toEqual([null, null])
})

test("counts requests until info.completed settles, including rejected completions", async () => {
  const { deno, server, running } = started(denoShutdownTimeout(0))
  const finished = deno.request()
  const aborted = deno.request()
  deno.request()
  finished.complete()
  aborted.fail(new Error("connection reset"))
  await tick()

  const stopping = server.stop(background())

  expect(await rejection(running)).toMatchObject({
    name: "DenoServerForceCloseError",
    code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE",
    timeoutMs: 0,
    activeRequests: 1
  })
  await stopping
})

test("draining answers 503 with Connection: close without entering the handler", async () => {
  const deno = new FakeDeno()
  let calls = 0
  const server = newDenoServerWithRuntime(() => {
    calls += 1
    return new Response("handled")
  }, deno)
  const running = server.start(background())
  const inFlight = deno.request()
  const stopping = server.stop(background())

  const refused = await deno.request().result

  expect(refused.status).toBe(503)
  expect(refused.headers.get("connection")).toBe("close")
  expect(refused.body).toBeNull()
  expect(calls).toBe(1)
  expect(deno.server.shutdownCalls).toBe(0)

  inFlight.complete()
  await stopping
  await running
})

test("an idle drain shuts down at once and never aborts", async () => {
  const { deno, server, running } = started()

  const stopping = server.stop(background())

  expect(deno.server.shutdownCalls).toBe(1)
  await stopping
  await running
  expect(deno.server.abortEvents).toBe(0)
})

test("an in-flight drain shuts down exactly once after the last request completes", async () => {
  const { deno, server, running } = started()
  const first = deno.request()
  const second = deno.request()

  const stopping = server.stop(background())
  first.complete()
  await tick()

  expect(deno.server.shutdownCalls).toBe(0)
  second.fail(new Error("client went away"))
  await stopping
  await running
  expect(deno.server.shutdownCalls).toBe(1)
  expect(deno.server.abortEvents).toBe(0)
})

test("the hard timeout aborts only while shutdown has not been called", async () => {
  const { deno, server, running } = started(denoShutdownTimeout(0))
  const inFlight = deno.request()

  const stopping = server.stop(background())

  expect(await rejection(running)).toMatchObject({ code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE" })
  await stopping
  expect(deno.server.abortEvents).toBe(1)
  expect(deno.server.shutdownCalls).toBe(0)
  inFlight.fail(new Error("aborted by the server"))
  await tick()
  expect(deno.server.abortEvents).toBe(1)
  expect(deno.server.unsafeAborts).toBe(0)
})

test("the hard timeout never aborts once shutdown was called", async () => {
  const { deno, server, running } = started(denoShutdownTimeout(0))

  const stopping = server.stop(background())

  expect(await rejection(running)).toMatchObject({
    code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE",
    activeRequests: 0
  })
  await stopping
  expect(deno.server.shutdownCalls).toBe(1)
  expect(deno.server.abortEvents).toBe(0)
})

test("a hanging shutdown stays pending after the deadline instead of being aborted", async () => {
  const { deno, server, running } = started(denoShutdownTimeout(10))
  deno.server.hangOnShutdown = true
  const inFlight = deno.request()
  let settled = false
  void running.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )

  const stopping = server.stop(background())
  inFlight.complete()
  await Bun.sleep(60)

  expect(deno.server.shutdownCalls).toBe(1)
  expect(deno.server.abortEvents).toBe(0)
  expect(settled).toBe(false)
  deno.server.finish()
  expect(await rejection(running)).toMatchObject({ code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE" })
  await stopping
})

test("a rejected shutdown promise is reported as the terminal failure", async () => {
  const { deno, server, running } = started()
  const failure = new Error("shutdown rejected")
  deno.server.shutdownRejection = failure

  const stopping = server.stop(background())

  expect(await rejection(running)).toBe(failure)
  await stopping
})

test("a synchronous shutdown failure during drain aborts only at the hard deadline", async () => {
  const { deno, server, running } = started(denoShutdownTimeout(20))
  const failure = new Error("shutdown threw")
  deno.server.shutdownFailure = failure

  const stopping = server.stop(background())

  await tick()
  expect(deno.server.abortEvents).toBe(0)
  expect(await rejection(running)).toMatchObject({
    name: "AggregateError",
    errors: [{ code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE" }, failure]
  })
  await stopping
  expect(deno.server.abortEvents).toBe(1)
  expect(deno.server.unsafeAborts).toBe(0)
})

test("a synchronous shutdown failure after the last request completes is reported and forced", async () => {
  const { deno, server, running } = started(denoShutdownTimeout(20))
  const failure = new Error("late shutdown threw")
  deno.server.shutdownFailure = failure
  const inFlight = deno.request()

  const stopping = server.stop(background())
  inFlight.complete()

  expect(await rejection(running)).toMatchObject({
    name: "AggregateError",
    errors: [{ code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE" }, failure]
  })
  await stopping
  expect(deno.server.abortEvents).toBe(1)
  expect(deno.server.unsafeAborts).toBe(0)
})

test("server.finished resolving without a stop is an unexpected close", async () => {
  const { deno, server, running } = started()

  deno.server.finish()

  const failure = await rejection(running)
  expect(failure).toMatchObject({
    name: "DenoServerUnexpectedCloseError",
    code: "GO_LIKE_DENO_SERVER_UNEXPECTED_CLOSE"
  })
  expect(await rejection(server.stop(background()))).toBe(failure)
  expect(deno.server.shutdownCalls).toBe(0)
  expect(deno.server.abortEvents).toBe(0)
})

test("server.finished rejecting is the primary failure", async () => {
  const { deno, server, running } = started()
  const failure = new Error("server died")

  deno.server.crash(failure)

  expect(await rejection(running)).toBe(failure)
  expect(await rejection(server.stop(background()))).toBe(failure)
})

const unusableAddresses: readonly (readonly [string, unknown])[] = [
  ["a missing address", undefined],
  ["a null address", null],
  ["an address without a port", { transport: "tcp" }],
  ["a non-numeric port", { port: "4321" }],
  ["a unix address", "unix:/tmp/socket"]
]

for (const [label, addr] of unusableAddresses) {
  test(`${label} fails startup only after the native host stopped`, async () => {
    const deno = new FakeDeno()
    deno.server.addr = addr
    const server = newDenoServerWithRuntime(() => new Response(), deno)

    const failure = await rejection(server.start(background()))

    expect(failure).toMatchObject({ message: "deno web server did not report a bound TCP port" })
    expect(deno.server.shutdownCalls).toBe(1)
    expect(deno.server.abortEvents).toBe(0)
  })
}

test("a synchronous bind failure keeps the runtime error identity for start, endpoint, and stop", async () => {
  const deno = new FakeDeno()
  const failure = Object.assign(new Error("address in use"), { code: "AddrInUse" })
  deno.serveFailure = failure
  const server = newDenoServerWithRuntime(() => new Response(), deno)

  expect(await rejection(server.start(background()))).toBe(failure)
  expect(await rejection(server.endpoint(background()))).toBe(failure)
  expect(await rejection(server.stop(background()))).toBe(failure)
  expect(deno.serveCalls).toHaveLength(1)
  expect(deno.server.shutdownCalls).toBe(0)
  expect(deno.server.abortEvents).toBe(0)
})
