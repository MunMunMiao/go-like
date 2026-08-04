import { EventEmitter } from "node:events"
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

import {
  nodeShutdownTimeout,
  hostname,
  newNodeServerWithFactory,
  port,
  type NativeFactory,
  type NodeServer
} from "../../src/node-server"

class FakeSocket extends EventEmitter {
  destroyed = false
  destroyFailure: Error | null = null
  emitCloseOnDestroy = true

  destroy(): void {
    this.destroyed = true
    if (this.destroyFailure !== null) throw this.destroyFailure
    if (this.emitCloseOnDestroy) this.emit("close")
  }
}

type FakeAddress =
  | {
      readonly address: string
      readonly family: "IPv4" | "IPv6"
      readonly port: number
    }
  | string
  | null

class FakeNativeServer extends EventEmitter {
  closeCalls = 0
  closeAllCalls = 0
  closeFailure: Error | null = null
  closeAllFailure: Error | null = null
  listenFailure: Error | null = null
  listenPort: number | null = null
  listenHost: string | null = null
  listenCallback: (() => void) | null = null
  closeCallback: ((error?: Error) => void) | null = null
  delayedListen = false
  closeBlockMs = 0
  finishCloseSynchronously = false
  synchronousCloseFailure: Error | null = null
  addressResult: FakeAddress | undefined

  listen(
    options: { readonly port: number; readonly host: string; readonly signal?: AbortSignal },
    callback: () => void
  ): void {
    this.listenPort = options.port
    this.listenHost = options.host
    if (this.listenFailure !== null) throw this.listenFailure
    this.listenCallback = callback
    if (!this.delayedListen) queueMicrotask(callback)
  }

  address(): FakeAddress {
    if (this.addressResult !== undefined) return this.addressResult
    return {
      address: this.listenHost ?? "127.0.0.1",
      family: "IPv4",
      port: this.listenPort === 0 ? 49_152 : (this.listenPort ?? 49_152)
    }
  }

  close(callback?: (error?: Error) => void): void {
    this.closeCalls += 1
    if (this.closeFailure !== null) throw this.closeFailure
    const deadline = performance.now() + this.closeBlockMs
    while (performance.now() < deadline) {
      // Intentionally block this test double to exercise monotonic deadline admission.
    }
    if (this.finishCloseSynchronously) {
      callback?.(this.synchronousCloseFailure ?? undefined)
      this.emit("close")
      return
    }
    this.closeCallback = callback ?? null
  }

  closeAllConnections(): void {
    this.closeAllCalls += 1
    if (this.closeAllFailure !== null) throw this.closeAllFailure
  }

  finishListen(): void {
    this.listenCallback?.()
  }

  finishClose(error?: Error): void {
    const callback = this.closeCallback
    this.closeCallback = null
    callback?.(error)
    this.emit("close")
  }
}

interface Fixture {
  readonly subject: NodeServer
  readonly fake: FakeNativeServer
  readonly captured: {
    handler: Handler | null
    hostname: string | null
  }
}

function fixture(handler: Handler = () => new Response("ok")): Fixture {
  const fake = new FakeNativeServer()
  const captured = { handler: null, hostname: null } as {
    handler: Handler | null
    hostname: string | null
  }
  const factory: NativeFactory = (fetchHandler, host) => {
    captured.handler = fetchHandler
    captured.hostname = host
    return fake as never
  }
  return {
    subject: newNodeServerWithFactory(handler, factory),
    fake,
    captured
  }
}

/** Starts one fake-backed server and waits through native listen admission. */
async function startRunning(
  subject: NodeServer,
  ctx: Context = background()
): Promise<{ readonly running: Promise<void> }> {
  const running = subject.start(ctx)
  await Promise.resolve()
  return { running }
}

test("passes one Fetch argument to the native factory and owns clean stop", async () => {
  const request = new Request("https://example.test/handler")
  const response = new Response("handled")
  const seen: { request: Request | null } = { request: null }
  const fake = new FakeNativeServer()
  const captured = { handler: null, hostname: null } as {
    handler: Handler | null
    hostname: string | null
  }
  const subject = newNodeServerWithFactory(
    (value) => {
      seen.request = value
      return response
    },
    (handler, host) => {
      captured.handler = handler
      captured.hostname = host
      return fake as never
    },
    hostname("127.0.0.2"),
    port(8_181)
  )

  expect(captured.handler).toBeNull()
  const { running } = await startRunning(subject)
  expect(captured.hostname).toBe("127.0.0.2")
  expect(captured.handler?.length).toBe(1)
  expect(captured.handler?.(request)).toBe(response)
  expect(seen.request).toBe(request)
  expect(fake.listenHost).toBe("127.0.0.2")
  expect(fake.listenPort).toBe(8_181)

  const stopped = subject.stop(background())
  expect(fake.closeCalls).toBe(1)
  fake.finishClose()
  await stopped
  await expect(running).resolves.toBeUndefined()
})

test("accepts a native IPv6 listen address", async () => {
  const ipv6 = fixture()
  ipv6.fake.addressResult = { address: "::1", family: "IPv6", port: 8_182 }
  const { running } = await startRunning(ipv6.subject)
  const ipv6Stopped = ipv6.subject.stop(background())
  ipv6.fake.finishClose()
  await Promise.all([ipv6Stopped, running])
})

test("rejects native pipe or unavailable addresses before admission", async () => {
  for (const address of [null, "node-fetch.pipe"] as const) {
    const invalid = fixture()
    invalid.fake.addressResult = address
    const starting = invalid.subject.start(background())
    await Promise.resolve()
    invalid.fake.finishClose()
    const outcome = await starting.then(
      () => Object.freeze({ state: "fulfilled" as const }),
      (error: unknown) => Object.freeze({ state: "rejected" as const, error })
    )
    expect(outcome.state).toBe("rejected")
    if (outcome.state === "rejected") {
      expect(outcome.error).toMatchObject({
        message: "node web server address is not a TCP address"
      })
    }
  }
})

test("rejects every restart with the current one-shot lifecycle state", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)

  await expect(subject.start(background())).rejects.toMatchObject({
    name: "NodeServerAlreadyStartedError",
    code: "GO_LIKE_NODE_SERVER_ALREADY_STARTED",
    status: "running"
  })

  const stopped = subject.stop(background())
  fake.finishClose()
  await stopped
  await expect(subject.start(background())).rejects.toMatchObject({ status: "stopped" })
})

test("pre-canceled startup consumes the server without constructing a native host", async () => {
  const [ctx, cancel] = withCancel(background())
  cancel()
  let factoryCalls = 0
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => {
      factoryCalls += 1
      return new FakeNativeServer() as never
    }
  )

  await expect(subject.start(ctx)).rejects.toThrow()
  expect(factoryCalls).toBe(0)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
})

test("normalizes non-Error cancellation values and uses the canonical fallback", async () => {
  const cancellationValue = Object.freeze({ kind: "external cancellation" })
  let nonErrorReads = 0
  const nonErrorContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal | null => null,
    err: (): Error | null => {
      nonErrorReads += 1
      if (nonErrorReads === 1) return new Error("terminal marker")
      if (nonErrorReads === 2) return null
      return cancellationValue as never
    },
    value: () => undefined
  }
  const normalized = fixture().subject

  await expect(normalized.start(nonErrorContext)).rejects.toMatchObject({
    message: "node web startup canceled with a non-Error value",
    cause: cancellationValue
  })
  expect(nonErrorReads).toBe(3)

  let fallbackReads = 0
  const fallbackContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal | null => null,
    err: (): Error | null => {
      fallbackReads += 1
      return fallbackReads === 1 ? new Error("terminal marker") : null
    },
    value: () => undefined
  }
  await expect(fixture().subject.start(fallbackContext)).rejects.toBe(canceled)
  expect(fallbackReads).toBe(3)
})

test("caller cancellation abandons only its stop wait and never forces owner drain", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)
  const [stopCtx] = withTimeout(background(), 1)

  await expect(subject.stop(stopCtx)).rejects.toThrow()
  expect(fake.closeCalls).toBe(1)
  expect(fake.closeAllCalls).toBe(0)

  const stopped = subject.stop(background())
  fake.finishClose()
  await stopped
  await expect(running).resolves.toBeUndefined()
})

test("ignores a stale owner timeout after clean terminal settlement", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")
  const captured: { ownerTimeout: (() => void) | null } = { ownerTimeout: null }
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (callback: () => void): number => {
      captured.ownerTimeout = callback
      return 1
    }
  })
  try {
    const { subject, fake } = fixture()
    const { running } = await startRunning(subject)
    const done = running
    const stopped = subject.stop(background())
    expect(captured.ownerTimeout).not.toBeNull()

    fake.finishClose()
    await stopped
    await expect(done).resolves.toBeUndefined()

    const staleTimeout = captured.ownerTimeout
    if (staleTimeout === null) throw new Error("owner timeout was not registered")
    staleTimeout()
    expect(running).toBe(done)
    await expect(running).resolves.toBeUndefined()
    expect(fake.closeAllCalls).toBe(0)
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "setTimeout")
    else Object.defineProperty(globalThis, "setTimeout", descriptor)
  }
})

test("Node shutdown timeout requests force but waits for native terminal", async () => {
  const fake = new FakeNativeServer()
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never,
    nodeShutdownTimeout(0)
  )
  const { running } = await startRunning(subject)
  const socket = new FakeSocket()
  const throwingSocket = new FakeSocket()
  const socketFailure = new Error("socket destroy failed")
  throwingSocket.destroyFailure = socketFailure
  fake.emit("connection", socket)
  fake.emit("connection", throwingSocket)

  const stopped = subject.stop(background())
  const stopBeforeListenerTerminal = await Promise.race([
    stopped.then(() => "stopped" as const),
    new Promise<"pending">((resolve) =>
      setTimeout(() => {
        resolve("pending")
      }, 20)
    )
  ])
  expect(fake.closeAllCalls).toBe(1)
  expect(socket.destroyed).toBe(true)
  expect(throwingSocket.destroyed).toBe(true)
  expect(stopBeforeListenerTerminal).toBe("pending")
  fake.finishClose()
  const stopBeforeSocketTerminal = await Promise.race([
    stopped.then(() => "stopped" as const),
    new Promise<"pending">((resolve) =>
      setTimeout(() => {
        resolve("pending")
      }, 20)
    )
  ])
  expect(stopBeforeSocketTerminal).toBe("pending")
  throwingSocket.emit("close")
  await stopped

  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  expect((terminal as AggregateError).errors).toHaveLength(2)
  expect((terminal as AggregateError).errors[0]).toMatchObject({
    name: "NodeServerForceCloseError",
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE",
    timeoutMs: 0,
    activeConnections: 2
  })
  expect((terminal as AggregateError).errors[1]).toBe(socketFailure)
  expect(await running.catch((error: unknown) => error)).toBe(terminal)
})

test("a connection admitted after force is destroyed and remains a terminal barrier when destroy throws", async () => {
  const fake = new FakeNativeServer()
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never,
    nodeShutdownTimeout(0)
  )
  const { running } = await startRunning(subject)
  const stopped = subject.stop(background())
  await new Promise((resolve) => setTimeout(resolve, 0))

  const lateSocket = new FakeSocket()
  const destroyFailure = new Error("late socket destroy failed")
  lateSocket.destroyFailure = destroyFailure
  fake.emit("connection", lateSocket)
  expect(lateSocket.destroyed).toBe(true)
  fake.finishClose()
  expect(
    await Promise.race([
      stopped.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => {
          resolve("pending")
        }, 10)
      )
    ])
  ).toBe("pending")

  lateSocket.emit("close")
  await stopped
  const failure = await running.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors[1]).toBe(destroyFailure)
})

test("passive close rejects as an unexpected terminal exit without closing native twice", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)

  fake.emit("close")

  const failure = await running.catch((error: unknown) => error)
  expect(failure).toMatchObject({
    name: "NodeServerUnexpectedCloseError",
    code: "GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE"
  })
  expect(fake.closeCalls).toBe(0)
  await expect(subject.stop(background())).rejects.toBe(failure)
  expect(fake.closeCalls).toBe(0)
})

test("monotonic Node shutdown deadline wins when native close blocks past its budget", async () => {
  const fake = new FakeNativeServer()
  fake.closeBlockMs = 10
  fake.finishCloseSynchronously = true
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never,
    nodeShutdownTimeout(1)
  )
  const { running } = await startRunning(subject)

  await expect(subject.stop(background())).resolves.toBeUndefined()
  await expect(running).rejects.toMatchObject({
    name: "NodeServerForceCloseError",
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE",
    timeoutMs: 1
  })
  expect(fake.closeAllCalls).toBe(1)
})

test("zero Node shutdown timeout is an immediate monotonic owner deadline", async () => {
  const fake = new FakeNativeServer()
  fake.closeBlockMs = 10
  fake.finishCloseSynchronously = true
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never,
    nodeShutdownTimeout(0)
  )
  const { running } = await startRunning(subject)

  await expect(subject.stop(background())).resolves.toBeUndefined()
  await expect(running).rejects.toMatchObject({
    name: "NodeServerForceCloseError",
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE",
    timeoutMs: 0
  })
  expect(fake.closeAllCalls).toBe(1)
})

test("close convergence rechecks the monotonic deadline before a delayed timer can dispatch", async () => {
  const fake = new FakeNativeServer()
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never,
    nodeShutdownTimeout(1)
  )
  const { running } = await startRunning(subject)
  const stopped = subject.stop(background())

  queueMicrotask(() => {
    const deadline = performance.now() + 10
    while (performance.now() < deadline) {
      // Keep the timer queued while native close convergence crosses the hard deadline.
    }
    fake.finishClose()
  })

  await expect(stopped).resolves.toBeUndefined()
  await expect(running).rejects.toMatchObject({
    name: "NodeServerForceCloseError",
    timeoutMs: 1
  })
})

test("native error preserves first identity and immediately forces active connections", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)
  const socket = new FakeSocket()
  const failure = new Error("native failure")
  fake.emit("connection", socket)

  fake.emit("error", failure)
  fake.emit("error", new Error("later failure"))

  expect(fake.closeCalls).toBe(1)
  expect(fake.closeAllCalls).toBe(1)
  expect(socket.destroyed).toBe(true)
  fake.finishClose()
  await expect(running).rejects.toBe(failure)
  await expect(subject.stop(background())).rejects.toBe(failure)
})

test("preserves the first native error across repeated owner-drain failures", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)
  const primary = new Error("owner drain failed")
  const later = new Error("later owner drain failure")

  const stopped = subject.stop(background())
  fake.emit("error", primary)
  fake.emit("error", later)
  fake.finishClose()

  await stopped
  await expect(running).rejects.toBe(primary)
  expect(fake.closeCalls).toBe(1)
  expect(fake.closeAllCalls).toBe(1)
})

test("startup native error waits for cleanup and rejects with original identity", async () => {
  const fake = new FakeNativeServer()
  fake.delayedListen = true
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )
  const failure = new Error("listen failed")
  const starting = subject.start(background())
  let settled = false
  void starting
    .finally(() => {
      settled = true
    })
    .catch(() => {})

  fake.emit("error", failure)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  expect(fake.closeCalls).toBe(1)
  fake.finishClose()

  await expect(starting).rejects.toBe(failure)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
})

test("synchronous listen failure waits for cleanup and preserves original identity", async () => {
  const fake = new FakeNativeServer()
  const failure = new Error("listen threw")
  fake.listenFailure = failure
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )
  const starting = subject.start(background())
  let settled = false
  void starting
    .finally(() => {
      settled = true
    })
    .catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(settled).toBe(false)
  expect(fake.closeCalls).toBe(1)
  fake.finishClose()
  await expect(starting).rejects.toBe(failure)
})

test("a listener that never became active does not require a close event after cleanup throws", async () => {
  const fake = new FakeNativeServer()
  const listenFailure = new Error("listen rejected before activation")
  const closeFailure = new Error("inactive listener close rejected")
  fake.listenFailure = listenFailure
  fake.closeFailure = closeFailure
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )

  const failure = await subject.start(background()).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).cause).toBe(listenFailure)
  expect((failure as AggregateError).errors).toEqual([listenFailure, closeFailure])
  expect(fake.closeAllCalls).toBe(1)
})

test("factory and Context inspection failures reject asynchronously and consume one-shot", async () => {
  const factoryFailure = new Error("factory failed")
  const factorySubject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => {
      throw factoryFailure
    }
  )
  let factoryStart: Promise<unknown> | null = null
  expect(() => {
    factoryStart = factorySubject.start(background())
  }).not.toThrow()
  await expect(factoryStart).rejects.toBe(factoryFailure)
  await expect(factorySubject.start(background())).rejects.toMatchObject({ status: "failed" })

  const contextFailure = new Error("Context.err failed")
  const failingContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal | null => null,
    err: (): Error | null => {
      throw contextFailure
    },
    value: () => undefined
  }
  const contextSubject = fixture().subject
  let contextStart: Promise<unknown> | null = null
  expect(() => {
    contextStart = contextSubject.start(failingContext)
  }).not.toThrow()
  await expect(contextStart).rejects.toBe(contextFailure)
  await expect(contextSubject.start(background())).rejects.toMatchObject({ status: "failed" })
})

test("preserves Error identity when the standard Error.isError hook is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  const failure = new Error("factory fallback failed")
  expect(Reflect.deleteProperty(Error, "isError")).toBe(true)
  try {
    const subject = newNodeServerWithFactory(
      () => new Response("ok"),
      () => {
        throw failure
      }
    )
    await expect(subject.start(background())).rejects.toBe(failure)
  } finally {
    if (descriptor !== undefined) Object.defineProperty(Error, "isError", descriptor)
  }
})

test("close throw remains pending until a real close event, while callback failure observes its close event", async () => {
  const thrown = fixture()
  const { running: thrownRunning } = await startRunning(thrown.subject)
  const closeThrow = new Error("close threw")
  thrown.fake.closeFailure = closeThrow

  const thrownStop = thrown.subject.stop(background())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(thrown.fake.closeAllCalls).toBe(1)
  expect(
    await Promise.race([
      thrownStop.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => {
          resolve("pending")
        }, 10)
      )
    ])
  ).toBe("pending")
  thrown.fake.emit("close")
  await expect(thrownStop).resolves.toBeUndefined()
  await expect(thrownRunning).rejects.toBe(closeThrow)

  const callback = fixture()
  const { running: callbackRunning } = await startRunning(callback.subject)
  const closeCallback = new Error("close callback failed")
  const stopped = callback.subject.stop(background())
  callback.fake.finishClose(closeCallback)

  await expect(stopped).resolves.toBeUndefined()
  await expect(callbackRunning).rejects.toBe(closeCallback)
  expect(callback.fake.closeAllCalls).toBe(1)
})

test("terminal failures aggregate in observation order across close and force cleanup", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)
  const socket = new FakeSocket()
  const primary = new Error("native primary")
  const closeFailure = new Error("close callback failed")
  const closeAllFailure = new Error("close all failed")
  const socketFailure = new Error("socket destroy failed")
  fake.finishCloseSynchronously = true
  fake.synchronousCloseFailure = closeFailure
  fake.closeAllFailure = closeAllFailure
  socket.destroyFailure = socketFailure
  fake.emit("connection", socket)

  fake.emit("error", primary)
  socket.emit("close")

  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  expect((terminal as AggregateError).cause).toBe(primary)
  expect((terminal as AggregateError).errors).toEqual([
    primary,
    closeFailure,
    closeAllFailure,
    socketFailure
  ])
  await expect(subject.stop(background())).rejects.toBe(terminal)
})

test("the same failure identity is admitted only once across lifecycle cleanup", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)
  const socket = new FakeSocket()
  const sharedFailure = new Error("shared failure")
  fake.finishCloseSynchronously = true
  fake.synchronousCloseFailure = sharedFailure
  fake.closeAllFailure = sharedFailure
  socket.destroyFailure = sharedFailure
  fake.emit("connection", socket)

  fake.emit("error", sharedFailure)
  socket.emit("close")

  await expect(running).rejects.toBe(sharedFailure)
})

test("does not promote an admitted cleanup identity during terminal re-entry", async () => {
  const { subject, fake } = fixture()
  const { running } = await startRunning(subject)
  const socket = new FakeSocket()
  const cleanupFailure = new Error("shared cleanup failure")
  socket.emitCloseOnDestroy = false
  fake.finishCloseSynchronously = true
  fake.synchronousCloseFailure = cleanupFailure
  fake.closeAllFailure = cleanupFailure
  fake.emit("connection", socket)

  const stopped = subject.stop(background())
  fake.emit("error", cleanupFailure)
  socket.emit("close")

  await stopped
  await expect(running).rejects.toBe(cleanupFailure)
  expect(fake.closeAllCalls).toBe(1)
})

test("forces safely when the native host omits or disables closeAllConnections", async () => {
  const absent = new FakeNativeServer()
  const withoutProperty = new Proxy(absent, {
    has(target, property): boolean {
      if (property === "closeAllConnections") return false
      return Reflect.has(target, property)
    }
  })
  const absentServer = newNodeServerWithFactory(
    () => new Response("ok"),
    () => withoutProperty as never,
    nodeShutdownTimeout(0)
  )
  const { running: absentRunning } = await startRunning(absentServer)
  const absentStop = absentServer.stop(background())
  await new Promise((resolve) => setTimeout(resolve, 0))
  absent.finishClose()
  await absentStop
  await expect(absentRunning).rejects.toMatchObject({
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE"
  })
  expect(absent.closeAllCalls).toBe(0)

  const disabled = new FakeNativeServer()
  Object.defineProperty(disabled, "closeAllConnections", { value: null })
  const disabledServer = newNodeServerWithFactory(
    () => new Response("ok"),
    () => disabled as never,
    nodeShutdownTimeout(0)
  )
  const { running: disabledRunning } = await startRunning(disabledServer)
  const disabledStop = disabledServer.stop(background())
  await new Promise((resolve) => setTimeout(resolve, 0))
  disabled.finishClose()
  await disabledStop
  await expect(disabledRunning).rejects.toMatchObject({
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE"
  })
  expect(disabled.closeAllCalls).toBe(0)
})

test("closeAllConnections failure joins the earlier terminal cause", async () => {
  const timeout = new FakeNativeServer()
  const closeAllFailure = new Error("close all failed")
  timeout.closeAllFailure = closeAllFailure
  const timeoutSubject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => timeout as never,
    nodeShutdownTimeout(0)
  )
  const { running: timeoutRunning } = await startRunning(timeoutSubject)
  const stopped = timeoutSubject.stop(background())
  await new Promise((resolve) => setTimeout(resolve, 0))
  timeout.finishClose()
  await stopped
  const terminal = await timeoutRunning.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  expect((terminal as AggregateError).errors).toHaveLength(2)
  expect((terminal as AggregateError).errors[0]).toMatchObject({
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE"
  })
  expect((terminal as AggregateError).errors[1]).toBe(closeAllFailure)
})

test("custom cancellation registration failures and lost startup races consume one-shot", async () => {
  const registrationFailure = new Error("afterFunc failed")
  const throwingSignal = new AbortController().signal
  const throwingContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal => throwingSignal,
    err: (): Error | null => null,
    value: () => undefined,
    afterFunc: () => {
      throw registrationFailure
    }
  }
  const throwing = fixture()

  await expect(throwing.subject.start(throwingContext)).rejects.toBe(registrationFailure)
  await expect(throwing.subject.start(background())).rejects.toMatchObject({ status: "failed" })

  const stopLostSignal = new AbortController().signal
  const stopLostContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal => stopLostSignal,
    err: (): Error | null => null,
    value: () => undefined,
    afterFunc: () => () => false
  }
  const stopLost = fixture()
  const starting = stopLost.subject.start(stopLostContext)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(stopLost.fake.closeCalls).toBe(1)
  stopLost.fake.finishClose()
  await expect(starting).rejects.toThrow()
})

test("a throwing startup cleanup cannot replace a non-Error factory failure", async () => {
  const factoryFailure = Object.freeze({ boundary: "factory" })
  const cleanupFailure = new Error("StopFunc cleanup failed")
  let cleanupCalls = 0
  const cleanupSignal = new AbortController().signal
  const cleanupContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal => cleanupSignal,
    err: (): Error | null => null,
    value: () => undefined,
    afterFunc: () => () => {
      cleanupCalls += 1
      throw cleanupFailure
    }
  }
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => {
      throw factoryFailure
    }
  )

  await expect(subject.start(cleanupContext)).rejects.toMatchObject({
    message: "node web native server factory failed",
    cause: factoryFailure
  })
  expect(cleanupCalls).toBe(1)
})

test("reentrant native listener registration preserves the first startup failure", async () => {
  const fake = new FakeNativeServer()
  const primary = new Error("native registration failure")
  const secondary = new Error("listener registration threw")
  const nativeOn = fake.on
  fake.on = function on(event, listener): FakeNativeServer {
    nativeOn.call(this, event, listener)
    if (event === "error") {
      listener(primary)
      throw secondary
    }
    return this
  }
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )

  const starting = subject.start(background())
  expect(fake.closeCalls).toBe(1)
  fake.finishClose()
  await expect(starting).rejects.toBe(primary)
})

test("clean stop during startup settles start without accepting a late listen", async () => {
  const { subject, fake } = fixture()
  fake.delayedListen = true
  const starting = subject.start(background())
  const stopping = subject.stop(background())

  fake.finishClose()
  const outcome = await Promise.race([
    Promise.all([starting, stopping]).then(() => "settled" as const),
    Bun.sleep(100).then(() => "timeout" as const)
  ])
  fake.finishListen()

  expect(outcome).toBe("settled")
  expect(fake.closeCalls).toBe(1)
})

test("clean stop during startup retains a throwing cancellation cleanup", async () => {
  const cleanupFailure = new Error("startup cleanup failed")
  const cleanupSignal = new AbortController().signal
  const cleanupContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal => cleanupSignal,
    err: (): Error | null => null,
    value: () => undefined,
    afterFunc: () => () => {
      throw cleanupFailure
    }
  }
  const { subject, fake } = fixture()
  fake.delayedListen = true
  const starting = subject.start(cleanupContext)
  const stopping = subject.stop(background())

  fake.finishClose()
  const outcome = await Promise.race([
    Promise.allSettled([starting, stopping]).then((results) => ({
      state: "settled" as const,
      results
    })),
    Bun.sleep(100).then(() => ({ state: "timeout" as const }))
  ])

  expect(outcome.state).toBe("settled")
  if (outcome.state !== "settled") return
  expect(outcome.results).toEqual([
    { status: "rejected", reason: cleanupFailure },
    { status: "fulfilled", value: undefined }
  ])
})

test("clean stop during startup retains an already admitted cancellation cause", async () => {
  const cancellation = new Error("startup canceled")
  const { subject, fake } = fixture()
  fake.delayedListen = true
  const [ctx, cancel] = withCancelCause(background())
  const starting = subject.start(ctx)
  cancel(cancellation)
  const stopping = subject.stop(background())

  fake.finishClose()
  const outcome = await Promise.race([
    Promise.allSettled([starting, stopping]).then((results) => ({
      state: "settled" as const,
      results
    })),
    Bun.sleep(100).then(() => ({ state: "timeout" as const }))
  ])

  expect(outcome.state).toBe("settled")
  if (outcome.state !== "settled") return
  expect(outcome.results).toEqual([
    { status: "rejected", reason: cancellation },
    { status: "fulfilled", value: undefined }
  ])
})

test("a late listen during startup stop cannot strand a close callback failure", async () => {
  const closeFailure = new Error("close callback failed")
  const { subject, fake } = fixture()
  fake.delayedListen = true
  const starting = subject.start(background())
  const stopping = subject.stop(background())

  fake.finishListen()
  const closeCallback = fake.closeCallback
  if (closeCallback === null) throw new Error("close callback was not registered")
  fake.closeCallback = null
  closeCallback(closeFailure)
  const outcome = await Promise.race([
    Promise.allSettled([starting, stopping]).then((results) => ({
      state: "settled" as const,
      results
    })),
    Bun.sleep(100).then(() => ({ state: "timeout" as const }))
  ])
  fake.emit("close")

  expect(outcome.state).toBe("settled")
  if (outcome.state !== "settled") return
  expect(outcome.results).toEqual([
    { status: "rejected", reason: closeFailure },
    { status: "fulfilled", value: undefined }
  ])
})

test("startup cancellation wins delayed listen and a late callback cannot admit the server", async () => {
  const fake = new FakeNativeServer()
  fake.delayedListen = true
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )
  const [ctx, cancel] = withCancel(background())
  const starting = subject.start(ctx)

  cancel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fake.closeCalls).toBe(1)
  fake.finishListen()
  fake.finishClose()

  await expect(starting).rejects.toThrow()
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
})

test("startup cancellation normalizes a Context cause lookup failure", async () => {
  const fake = new FakeNativeServer()
  fake.delayedListen = true
  const lookupFailure = new Error("cancellation lookup failed")
  let canceled = false
  const registration: { callback: (() => void) | null } = { callback: null }
  const failingSignal = new AbortController().signal
  const failingContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal => failingSignal,
    err: (): Error | null => {
      if (canceled) throw lookupFailure
      return null
    },
    value: () => undefined,
    afterFunc: (callback: () => void) => {
      registration.callback = callback
      return () => false
    }
  }
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )
  const starting = subject.start(failingContext)

  canceled = true
  registration.callback?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  fake.finishClose()

  await expect(starting).rejects.toBe(lookupFailure)
})

test("a native close during startup rejects after cleanup convergence", async () => {
  const fake = new FakeNativeServer()
  fake.delayedListen = true
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )
  const starting = subject.start(background())

  fake.emit("close")

  await expect(starting).rejects.toThrow("node web server closed during startup")
  expect(fake.closeCalls).toBe(0)
})

test("a startup StopFunc failure preserves its identity and cleans up the native host", async () => {
  const fake = new FakeNativeServer()
  const stopFailure = new Error("startup StopFunc failed")
  const failingSignal = new AbortController().signal
  const failingContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal => failingSignal,
    err: (): Error | null => null,
    value: () => undefined,
    afterFunc: () => () => {
      throw stopFailure
    }
  }
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never
  )
  const starting = subject.start(failingContext)

  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fake.closeCalls).toBe(1)
  fake.finishClose()

  await expect(starting).rejects.toBe(stopFailure)
})

test("functional options validate once and snapshot host port and timeout", async () => {
  const mutable = { host: "127.0.0.3", port: 9_090, timeout: 100 }
  const hostOption = hostname(mutable.host)
  const portOption = port(mutable.port)
  const timeoutOption = nodeShutdownTimeout(mutable.timeout)
  mutable.host = "127.0.0.4"
  mutable.port = 9_091
  mutable.timeout = 0
  const fake = new FakeNativeServer()
  const subject = newNodeServerWithFactory(
    () => new Response("ok"),
    () => fake as never,
    hostOption,
    portOption,
    timeoutOption
  )

  const { running } = await startRunning(subject)
  expect(fake.listenHost).toBe("127.0.0.3")
  expect(fake.listenPort).toBe(9_090)
  const stopped = subject.stop(background())
  fake.finishClose()
  await stopped
})

test("rejects an overflowing structural timeout before it can trigger immediate force", async () => {
  const fake = new FakeNativeServer()
  let subject: NodeServer | null = null
  let constructionFailure: unknown = null
  try {
    subject = newNodeServerWithFactory(
      () => new Response("ok"),
      () => fake as never,
      (options) =>
        Object.freeze({
          hostname: options.hostname,
          port: options.port,
          shutdownTimeoutMs: 2_147_483_648
        })
    )
  } catch (error) {
    constructionFailure = error
  }

  if (subject === null) {
    expect(constructionFailure).toBeInstanceOf(RangeError)
    expect(fake.listenHost).toBeNull()
    return
  }

  const { running } = await startRunning(subject)
  const stopped = subject.stop(background())
  await new Promise((resolve) => setTimeout(resolve, 20))
  const closeAllCalls = fake.closeAllCalls
  fake.finishClose()
  await stopped
  await running.catch(() => {})

  expect(closeAllCalls).toBe(0)
  expect(constructionFailure).toBeInstanceOf(RangeError)
})
