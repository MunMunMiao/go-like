import { expect, test } from "bun:test"
import {
  background,
  canceled,
  withCancel,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"
import type { Handler } from "@go-like/web"

import type { NativeRuntimeTag } from "../../src/native-errors"
import {
  nativeHostname,
  nativePort,
  nativeShutdownTimeout,
  type NativeServerOption,
  type NativeServerOptions
} from "../../src/native-options"
import {
  failureResponse,
  newNativeServer,
  type NativeBind,
  type NativeBinding,
  type NativeWebServer
} from "../../src/native-server"

const bun: NativeRuntimeTag<"bun"> = { id: "bun", name: "Bun", code: "BUN" }
const deno: NativeRuntimeTag<"deno"> = { id: "deno", name: "Deno", code: "DENO" }

class FakeBinding implements NativeBinding {
  port: number | undefined = 49_152
  active = 0
  drainCalls = 0
  forceCalls = 0
  drainFailure: Error | null = null
  forceFailure: Error | null = null
  drainBlockMs = 0
  readonly closed: Promise<void>
  private resolveClosed: () => void = () => {}
  private rejectClosed: (error: unknown) => void = () => {}

  constructor() {
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
  }

  activeRequests(): number {
    return this.active
  }

  drain(): void {
    this.drainCalls += 1
    const deadline = performance.now() + this.drainBlockMs
    while (performance.now() < deadline) {
      // Intentionally block this test double to exercise monotonic deadline admission.
    }
    if (this.drainFailure !== null) throw this.drainFailure
  }

  force(): void {
    this.forceCalls += 1
    if (this.forceFailure !== null) throw this.forceFailure
  }

  finish(): void {
    this.resolveClosed()
  }

  fail(error: unknown): void {
    this.rejectClosed(error)
  }
}

class FakeHost {
  bindCalls = 0
  failBind = false
  bindFailure: unknown = null
  binding = new FakeBinding()
  captured: {
    handler: Handler | null
    options: NativeServerOptions | null
    report: ((error: unknown) => void) | null
  } = { handler: null, options: null, report: null }

  readonly bind: NativeBind = (handler, options, report) => {
    this.bindCalls += 1
    this.captured = { handler, options, report }
    if (this.failBind) throw this.bindFailure
    return this.binding
  }
}

interface Fixture {
  readonly host: FakeHost
  readonly subject: NativeWebServer
}

/** Builds one Bun-tagged server over a controllable fake binding. */
function fixture(...options: NativeServerOption[]): Fixture {
  const host = new FakeHost()
  return { host, subject: newNativeServer(bun, () => new Response("ok"), host.bind, options) }
}

/** Waits for macrotasks so promise reactions and due timers have run. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reports whether a promise is still unsettled after a short observation window. */
async function isPending(promise: Promise<unknown>, waitMs = 20): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => false,
      () => false
    ),
    tick(waitMs).then(() => true)
  ])
}

/** Polls until a condition holds so load-sensitive timers never cause a fixed-sleep race. */
async function until(condition: () => boolean, limitMs = 2_000): Promise<void> {
  const limit = performance.now() + limitMs
  while (!condition()) {
    if (performance.now() > limit) throw new Error("condition was not reached in time")
    await tick(1)
  }
}

/** Builds a structural Context whose cancellation lookups are fully scripted by the test. */
function scriptedContext(err: () => Error | null): Context {
  return { deadline: () => [new Date(0), false], done: () => null, err, value: () => undefined }
}

test("construction has no side effects and start binds once with the exact handler and options", async () => {
  const host = new FakeHost()
  const handler: Handler = () => new Response("ok")
  const subject = newNativeServer(bun, handler, host.bind, [
    nativeHostname("bun", "127.0.0.2"),
    nativePort("bun", 8_181)
  ])
  expect(host.bindCalls).toBe(0)
  expect(subject.protocol()).toBe("http")
  expect(Object.isFrozen(subject)).toBe(true)

  const running = subject.start(background())

  expect(host.bindCalls).toBe(1)
  expect(host.captured.handler).toBe(handler)
  expect(host.captured.options).toEqual({
    hostname: "127.0.0.2",
    port: 8_181,
    shutdownTimeoutMs: 25_000
  })
  expect(Object.isFrozen(host.captured.options)).toBe(true)
  expect(await isPending(running)).toBe(true)

  const stopped = subject.stop(background())
  expect(host.binding.drainCalls).toBe(1)
  expect(await isPending(stopped)).toBe(true)
  host.binding.finish()
  await expect(stopped).resolves.toBeUndefined()
  await expect(running).resolves.toBeUndefined()
  expect(host.binding.forceCalls).toBe(0)
})

test("validates the handler before the options and never binds on a construction failure", () => {
  const host = new FakeHost()

  expect(() => newNativeServer(bun, undefined as never, host.bind, [])).toThrow(
    "handler must be callable"
  )
  expect(() =>
    newNativeServer(bun, undefined as never, host.bind, [nativeShutdownTimeout("bun", 0)])
  ).toThrow(TypeError)
  expect(() => newNativeServer(bun, () => new Response(), host.bind, [undefined as never])).toThrow(
    "bun server option must be callable"
  )
  expect(() =>
    newNativeServer(deno, () => new Response(), host.bind, [
      () => ({ hostname: "", port: 0, shutdownTimeoutMs: 1 })
    ])
  ).toThrow("deno hostname must be a non-empty string")
  expect(host.bindCalls).toBe(0)
})

test("rejects every restart with the current one-shot lifecycle state", async () => {
  const { host, subject } = fixture()
  const running = subject.start(background())

  await expect(subject.start(background())).rejects.toMatchObject({
    name: "BunServerAlreadyStartedError",
    code: "GO_LIKE_BUN_SERVER_ALREADY_STARTED",
    status: "running"
  })

  const stopped = subject.stop(background())
  await expect(subject.start(background())).rejects.toMatchObject({ status: "stopping" })
  host.binding.finish()
  await stopped
  await running
  await expect(subject.start(background())).rejects.toMatchObject({ status: "stopped" })
  expect(host.bindCalls).toBe(1)
})

test("stop before start resolves, stays idle, and leaves the server startable", async () => {
  const { host, subject } = fixture()

  await expect(subject.stop(background())).resolves.toBeUndefined()
  expect(host.bindCalls).toBe(0)
  expect(host.binding.drainCalls).toBe(0)

  const running = subject.start(background())
  expect(host.bindCalls).toBe(1)
  const stopped = subject.stop(background())
  host.binding.finish()
  await stopped
  await expect(running).resolves.toBeUndefined()
})

test("endpoint binds once, shares the listener with start, and reports the actual port", async () => {
  const { host, subject } = fixture(nativePort("bun", 0))

  const endpoint = await subject.endpoint(background())
  expect(endpoint).toBe("http://127.0.0.1:49152/")
  expect(host.bindCalls).toBe(1)

  const running = subject.start(background())
  expect(host.bindCalls).toBe(1)
  expect(await subject.endpoint(background())).toBe(endpoint)
  expect(host.bindCalls).toBe(1)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "running" })

  const stopped = subject.stop(background())
  host.binding.finish()
  await stopped
  await running
})

test("endpoint brackets IPv6 hostnames exactly once and keeps other hostnames verbatim", async () => {
  for (const [configured, expected] of [
    ["::1", "http://[::1]:49152/"],
    ["[::1]", "http://[::1]:49152/"],
    ["0.0.0.0", "http://0.0.0.0:49152/"],
    ["localhost", "http://localhost:49152/"]
  ] as const) {
    const { subject } = fixture(nativeHostname("bun", configured))

    expect(await subject.endpoint(background())).toBe(expected)
  }
})

test("endpoint never returns a stale endpoint while draining or after the terminal state", async () => {
  const { host, subject } = fixture()
  const running = subject.start(background())
  await subject.endpoint(background())

  const stopped = subject.stop(background())
  await expect(subject.endpoint(background())).rejects.toThrow("bun web server is not bound")
  host.binding.finish()
  await stopped
  await running
  await expect(subject.endpoint(background())).rejects.toThrow("bun web server is not bound")
})

test("endpoint honors caller cancellation even after the listener is bound", async () => {
  const { subject } = fixture()
  void subject.start(background())
  const [ctx, cancel] = withCancel(background())
  cancel()

  await expect(subject.endpoint(ctx)).rejects.toBe(canceled)
})

test("bind failure rejects start, endpoint, and stop with one identity and needs no cleanup", async () => {
  const failure = new Error("EADDRINUSE")
  const { host, subject } = fixture()
  host.failBind = true
  host.bindFailure = failure

  let starting: Promise<void> | null = null
  expect(() => {
    starting = subject.start(background())
  }).not.toThrow()
  await expect(starting).rejects.toBe(failure)
  await expect(subject.endpoint(background())).rejects.toBe(failure)
  await expect(subject.stop(background())).rejects.toBe(failure)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
  expect(host.bindCalls).toBe(1)
  expect(host.binding.drainCalls).toBe(0)
  expect(host.binding.forceCalls).toBe(0)
})

test("a non-Error bind failure is wrapped with a stable message and its original cause", async () => {
  const { host, subject } = fixture()
  host.failBind = true
  host.bindFailure = "denied"

  const failure: unknown = await subject.start(background()).catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(Error)
  expect(failure).toMatchObject({ message: "bun web server bind failed", cause: "denied" })
  expect(Object.isFrozen(failure)).toBe(true)
})

test("endpoint alone surfaces a bind failure and does not leak an unhandled rejection", async () => {
  const observed: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    observed.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    const failure = new Error("bind failed for endpoint")
    const { host, subject } = fixture()
    host.failBind = true
    host.bindFailure = failure

    await expect(subject.endpoint(background())).rejects.toBe(failure)
    await tick(20)
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }

  expect(observed).toEqual([])
})

test("a pre-canceled startup consumes the server without binding", async () => {
  const cause = new Error("shutdown requested")
  const [withCause, cancelWithCause] = withCancelCause(background())
  cancelWithCause(cause)
  const [plain, cancelPlain] = withCancel(background())
  cancelPlain()

  const first = fixture()
  await expect(first.subject.start(withCause)).rejects.toBe(cause)
  const second = fixture()
  await expect(second.subject.start(plain)).rejects.toBe(canceled)

  expect(first.host.bindCalls).toBe(0)
  expect(second.host.bindCalls).toBe(0)
  await expect(first.subject.start(background())).rejects.toMatchObject({ status: "failed" })
  await expect(first.subject.endpoint(background())).rejects.toBe(cause)
  await expect(first.subject.stop(background())).rejects.toBe(cause)
})

test("startup cancellation normalizes non-Error values and falls back to the canonical error", async () => {
  const cancellationValue = Object.freeze({ kind: "external cancellation" })
  let nonErrorReads = 0
  const nonError = scriptedContext((): Error | null => {
    nonErrorReads += 1
    if (nonErrorReads === 1) return new Error("terminal marker")
    if (nonErrorReads === 2) return null
    return cancellationValue as never
  })
  await expect(fixture().subject.start(nonError)).rejects.toMatchObject({
    message: "bun web startup canceled",
    cause: cancellationValue
  })
  expect(nonErrorReads).toBe(3)

  let fallbackReads = 0
  const fallback = scriptedContext((): Error | null => {
    fallbackReads += 1
    return fallbackReads === 1 ? new Error("terminal marker") : null
  })
  await expect(fixture().subject.start(fallback)).rejects.toBe(canceled)
  expect(fallbackReads).toBe(3)
})

test("Context inspection failures reject asynchronously and consume the one-shot server", async () => {
  const inspection = new Error("Context.err failed")
  const failing = fixture()
  let starting: Promise<void> | null = null
  expect(() => {
    starting = failing.subject.start(
      scriptedContext(() => {
        throw inspection
      })
    )
  }).not.toThrow()
  await expect(starting).rejects.toBe(inspection)
  await expect(failing.subject.start(background())).rejects.toMatchObject({ status: "failed" })

  const lookup = new Error("cancellation lookup failed")
  let reads = 0
  const lookupFailing = fixture()
  await expect(
    lookupFailing.subject.start(
      scriptedContext((): Error | null => {
        reads += 1
        if (reads === 1) return new Error("terminal marker")
        throw lookup
      })
    )
  ).rejects.toBe(lookup)
  expect(failing.host.bindCalls).toBe(0)
  expect(lookupFailing.host.bindCalls).toBe(0)
})

test("a host that reports no usable port is drained, forced, and rejected after it converges", async () => {
  for (const port of [undefined, 0, 65_536, 1.5, Number.NaN, -1]) {
    const { host, subject } = fixture()
    host.binding.port = port

    const starting = subject.start(background())
    expect(host.binding.drainCalls).toBe(1)
    expect(host.binding.forceCalls).toBe(1)
    expect(await isPending(starting)).toBe(true)
    host.binding.finish()

    await expect(starting).rejects.toThrow("bun web server did not report a bound TCP port")
    await expect(subject.endpoint(background())).rejects.toThrow(
      "bun web server did not report a bound TCP port"
    )
    await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
  }
})

test("caller cancellation abandons only its stop wait and never forces owner drain", async () => {
  const { host, subject } = fixture()
  const running = subject.start(background())
  const [stopCtx] = withTimeout(background(), 1)

  await expect(subject.stop(stopCtx)).rejects.toThrow()
  expect(host.binding.drainCalls).toBe(1)
  expect(host.binding.forceCalls).toBe(0)

  const stopped = subject.stop(background())
  const joined = subject.stop(background())
  expect(host.binding.drainCalls).toBe(1)
  host.binding.finish()
  await Promise.all([stopped, joined])
  await expect(running).resolves.toBeUndefined()
  await expect(subject.stop(background())).resolves.toBeUndefined()
})

test("zero shutdown timeout is an immediate deadline that forces once and waits for native terminal", async () => {
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 0))
  const running = subject.start(background())

  const stopped = subject.stop(background())

  expect(host.binding.forceCalls).toBe(1)
  expect(await isPending(stopped)).toBe(true)
  host.binding.finish()
  await stopped
  const failure = await running.catch((error: unknown) => error)
  expect(failure).toMatchObject({
    name: "BunServerForceCloseError",
    code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE",
    timeoutMs: 0,
    activeRequests: 0
  })
  expect(await running.catch((error: unknown) => error)).toBe(failure)
  await expect(subject.stop(background())).rejects.toBe(failure)
})

test("the force-close error reports the in-flight count observed when force begins", async () => {
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 0))
  host.binding.active = 3
  const running = subject.start(background())

  const stopped = subject.stop(background())
  host.binding.finish()
  await stopped

  await expect(running).rejects.toMatchObject({ timeoutMs: 0, activeRequests: 3 })
})

test("the configured timer forces exactly once and only native settlement is terminal", async () => {
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 5))
  host.binding.active = 1
  const running = subject.start(background())
  const stopped = subject.stop(background())
  expect(host.binding.forceCalls).toBe(0)

  await until(() => host.binding.forceCalls === 1)
  await tick(30)

  expect(host.binding.forceCalls).toBe(1)
  expect(await isPending(stopped)).toBe(true)
  host.binding.finish()
  await stopped
  await expect(running).rejects.toMatchObject({
    name: "BunServerForceCloseError",
    timeoutMs: 5,
    activeRequests: 1
  })
})

test("a host that never settles after force keeps start pending and never fabricates a terminal state", async () => {
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 0))
  const running = subject.start(background())
  const stopped = subject.stop(background())

  await tick(30)

  expect(host.binding.forceCalls).toBe(1)
  expect(await isPending(running)).toBe(true)
  expect(await isPending(stopped)).toBe(true)
  host.binding.finish()
  await stopped
  await running.catch(() => {})
})

test("monotonic deadline wins when native drain blocks past its budget", async () => {
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 1))
  const running = subject.start(background())
  host.binding.drainBlockMs = 10
  host.binding.finish()

  await expect(subject.stop(background())).resolves.toBeUndefined()

  await expect(running).rejects.toMatchObject({
    name: "BunServerForceCloseError",
    timeoutMs: 1
  })
  expect(host.binding.forceCalls).toBe(1)
})

test("close convergence rechecks the monotonic deadline before a delayed timer can dispatch", async () => {
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 1))
  const running = subject.start(background())
  const stopped = subject.stop(background())
  expect(host.binding.forceCalls).toBe(0)

  queueMicrotask(() => {
    const deadline = performance.now() + 10
    while (performance.now() < deadline) {
      // Keep the timer queued while native close convergence crosses the hard deadline.
    }
    host.binding.finish()
  })

  await expect(stopped).resolves.toBeUndefined()
  await expect(running).rejects.toMatchObject({ name: "BunServerForceCloseError", timeoutMs: 1 })
  expect(host.binding.forceCalls).toBe(1)
})

test("a clean drain inside its budget is not a failure and releases the owner timer", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")
  const captured: { timeout: (() => void) | null; cleared: number } = { timeout: null, cleared: 0 }
  const originalClear = globalThis.clearTimeout
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (callback: () => void): number => {
      captured.timeout = callback
      return 7
    }
  })
  globalThis.clearTimeout = ((handle: unknown): void => {
    if (handle === 7) captured.cleared += 1
  }) as typeof clearTimeout
  try {
    const { host, subject } = fixture()
    const running = subject.start(background())
    const stopped = subject.stop(background())
    expect(captured.timeout).not.toBeNull()

    host.binding.finish()
    await stopped
    await expect(running).resolves.toBeUndefined()
    expect(captured.cleared).toBe(1)

    const stale = captured.timeout
    if (stale === null) throw new Error("owner timeout was not registered")
    stale()
    await expect(running).resolves.toBeUndefined()
    expect(host.binding.forceCalls).toBe(0)
  } finally {
    globalThis.clearTimeout = originalClear
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "setTimeout")
    else Object.defineProperty(globalThis, "setTimeout", descriptor)
  }
})

test("a drain failure is admitted and escalates to force while the terminal stays native", async () => {
  const drainFailure = new Error("drain threw")
  const { host, subject } = fixture()
  host.binding.drainFailure = drainFailure
  const running = subject.start(background())

  const stopped = subject.stop(background())

  expect(host.binding.drainCalls).toBe(1)
  expect(host.binding.forceCalls).toBe(1)
  expect(await isPending(stopped)).toBe(true)
  host.binding.finish()
  await stopped
  await expect(running).rejects.toBe(drainFailure)
})

test("terminal failures aggregate in observation order with the primary cause first", async () => {
  const drainFailure = new Error("drain threw")
  const forceFailure = new Error("force threw")
  const closeFailure = new Error("close rejected")
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 0))
  host.binding.drainFailure = drainFailure
  host.binding.forceFailure = forceFailure
  const running = subject.start(background())

  const stopped = subject.stop(background())
  host.binding.fail(closeFailure)
  await stopped

  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  expect(Object.isFrozen(terminal)).toBe(true)
  const aggregate = terminal as AggregateError
  expect(aggregate.message).toBe("bun web server lifecycle failed")
  expect(aggregate.errors).toHaveLength(4)
  expect(aggregate.errors[0]).toMatchObject({ name: "BunServerForceCloseError", timeoutMs: 0 })
  expect(aggregate.errors.slice(1)).toEqual([drainFailure, forceFailure, closeFailure])
  expect(aggregate.cause).toBe(aggregate.errors[0])
  expect(host.binding.forceCalls).toBe(1)
  await expect(subject.stop(background())).rejects.toBe(terminal)
})

test("the same failure identity is admitted only once across drain, force, and close", async () => {
  const shared = new Error("shared failure")
  const { host, subject } = fixture()
  host.binding.drainFailure = shared
  host.binding.forceFailure = shared
  const running = subject.start(background())

  const stopped = subject.stop(background())
  host.binding.fail(shared)
  await stopped

  await expect(running).rejects.toBe(shared)
})

test("a native close rejection during owner drain is the terminal failure", async () => {
  const closeFailure = new Error("close rejected")
  const { host, subject } = fixture()
  const running = subject.start(background())

  const stopped = subject.stop(background())
  host.binding.fail(closeFailure)

  await expect(stopped).resolves.toBeUndefined()
  await expect(running).rejects.toBe(closeFailure)
  expect(host.binding.forceCalls).toBe(0)
})

test("a non-Error native close rejection is wrapped with its original cause", async () => {
  const { host, subject } = fixture()
  const running = subject.start(background())

  const stopped = subject.stop(background())
  host.binding.fail("close string")
  await stopped

  await expect(running).rejects.toMatchObject({
    message: "bun web server close failed",
    cause: "close string"
  })
})

test("a force failure joins the earlier deadline cause", async () => {
  const forceFailure = new Error("force threw")
  const { host, subject } = fixture(nativeShutdownTimeout("bun", 0))
  host.binding.forceFailure = forceFailure
  const running = subject.start(background())

  const stopped = subject.stop(background())
  host.binding.finish()
  await stopped

  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  expect((terminal as AggregateError).errors).toHaveLength(2)
  expect((terminal as AggregateError).errors[0]).toMatchObject({
    code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE"
  })
  expect((terminal as AggregateError).errors[1]).toBe(forceFailure)
})

test("passive native close rejects as an unexpected terminal exit without draining or forcing", async () => {
  const { host, subject } = fixture()
  const running = subject.start(background())

  host.binding.finish()

  const failure = await running.catch((error: unknown) => error)
  expect(failure).toMatchObject({
    name: "BunServerUnexpectedCloseError",
    code: "GO_LIKE_BUN_SERVER_UNEXPECTED_CLOSE"
  })
  expect(host.binding.drainCalls).toBe(0)
  expect(host.binding.forceCalls).toBe(0)
  await expect(subject.stop(background())).rejects.toBe(failure)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
  await expect(subject.endpoint(background())).rejects.toThrow("bun web server is not bound")
  expect(host.binding.drainCalls).toBe(0)
})

test("a passive native close rejection is the primary failure and keeps its identity", async () => {
  const hostFailure = new Error("native accept loop failed")
  const { host, subject } = fixture()
  const running = subject.start(background())

  host.binding.fail(hostFailure)

  await expect(running).rejects.toBe(hostFailure)
  await expect(subject.stop(background())).rejects.toBe(hostFailure)
  expect(host.binding.drainCalls).toBe(0)
  expect(host.binding.forceCalls).toBe(0)
})

test("only endpoint was called and the host later fails: no unhandled rejection is published", async () => {
  const observed: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    observed.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    const { host, subject } = fixture()
    await subject.endpoint(background())

    host.binding.fail(new Error("late host failure"))
    await tick(20)
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }

  expect(observed).toEqual([])
})

test("independent host failures are cleanup failures and are ignored after the terminal state", async () => {
  const first = new Error("host reported failure")
  const { host, subject } = fixture()
  const running = subject.start(background())

  host.captured.report?.(first)
  host.captured.report?.(first)
  host.captured.report?.("raw report")
  const stopped = subject.stop(background())
  host.binding.finish()
  await stopped

  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  const aggregate = terminal as AggregateError
  expect(aggregate.errors).toHaveLength(2)
  expect(aggregate.errors[0]).toBe(first)
  expect(aggregate.errors[1]).toMatchObject({
    message: "bun web host failed",
    cause: "raw report"
  })
  expect(aggregate.cause).toBe(first)

  host.captured.report?.(new Error("after terminal"))
  await expect(subject.stop(background())).rejects.toBe(terminal)
})

test("a single reported failure alone makes the clean drain fail with that identity", async () => {
  const reported = new Error("shutdown promise rejected")
  const { host, subject } = fixture()
  const running = subject.start(background())

  host.captured.report?.(reported)
  const stopped = subject.stop(background())
  host.binding.finish()
  await stopped

  await expect(running).rejects.toBe(reported)
})

test("the lifecycle core labels errors and messages with the owning runtime", async () => {
  const host = new FakeHost()
  const subject = newNativeServer(deno, () => new Response("ok"), host.bind, [])
  const running = subject.start(background())

  await expect(subject.start(background())).rejects.toMatchObject({
    name: "DenoServerAlreadyStartedError",
    code: "GO_LIKE_DENO_SERVER_ALREADY_STARTED"
  })
  host.binding.finish()

  await expect(running).rejects.toMatchObject({
    name: "DenoServerUnexpectedCloseError",
    message: "deno web server closed unexpectedly"
  })
})

test("failureResponse maps handler failures to empty 500 and TimeoutError to empty 504", async () => {
  class TimeoutError extends Error {}
  const named = new Error("named")
  named.name = "TimeoutError"
  const aborted = AbortSignal.timeout(1)
  await until(() => aborted.aborted)

  for (const [failure, status] of [
    [new Error("boom"), 500],
    [new TypeError("bad"), 500],
    ["string failure", 500],
    [undefined, 500],
    [named, 504],
    [new TimeoutError("typed"), 504],
    [aborted.reason, 504]
  ] as const) {
    const response = failureResponse(failure)

    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
  }
})
