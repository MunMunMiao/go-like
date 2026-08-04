import { describe, expect, test } from "bun:test"

import { background, canceled, withCancelCause } from "@go-like/context"
import type { Server } from "@go-like/core"

import { pinoDrainTimeout, type PinoDrainTimeoutError } from "../src/index"
import { delay, fakePinoServer, FakeDestination, FakeLogger, withoutForce } from "./helpers"

describe("native Pino destination lifecycle", () => {
  test("transfers ownership at start and returns one stable runtime Promise", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    const server: Server = fakePinoServer(logger.official(destination), destination)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)

    const running = server.start(background())
    expect(destination.listenerCount("error")).toBe(1)
    expect(destination.listenerCount("close")).toBe(1)
    await Promise.all([server.stop(background()), server.stop(background()), running])
    expect(logger.flushCalls).toBe(1)
    expect(destination.endCalls).toBe(1)
    expect(destination.destroyCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
  })

  test("keeps a pre-canceled unstarted destination under application ownership", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    const server = fakePinoServer(logger.official(destination), destination)
    const startup = withCancelCause(background())
    const failure = new Error("startup canceled")
    startup[1](failure)

    await expect(server.start(startup[0])).rejects.toBe(failure)
    expect(destination.endCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
    await expect(server.start(background())).rejects.toMatchObject({
      name: "PinoAlreadyStartedError",
      status: "failed"
    })
  })

  test("rejects a destination that was already closed before ownership transfer", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    destination.close()
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toMatchObject({
      name: "PinoDestinationClosedError",
      code: "GO_LIKE_PINO_DESTINATION_CLOSED"
    })
    expect(destination.endCalls).toBe(0)
    expect(destination.destroyCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
    await expect(server.start(background())).rejects.toMatchObject({
      name: "PinoAlreadyStartedError",
      status: "failed"
    })
  })

  test("rejects an ending file destination before ownership transfer", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    destination._ending = true
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toMatchObject({
      name: "PinoDestinationClosedError",
      code: "GO_LIKE_PINO_DESTINATION_CLOSED"
    })
    expect(destination.endCalls).toBe(0)
    expect(destination.destroyCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
  })

  test("rejects an already closed ThreadStream-like transport before ownership transfer", async () => {
    const logger = new FakeLogger()
    const native = new FakeDestination()
    native.close()
    const destination = withoutForce(native)
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toMatchObject({
      name: "PinoDestinationClosedError",
      code: "GO_LIKE_PINO_DESTINATION_CLOSED"
    })
    expect(native.endCalls).toBe(0)
    expect(native.destroyCalls).toBe(0)
    expect(native.listenerCount("error")).toBe(0)
    expect(native.listenerCount("close")).toBe(0)
  })

  test("preserves a preexisting ThreadStream-like writable error identity", async () => {
    const logger = new FakeLogger()
    const native = new FakeDestination()
    const failure = new Error("transport already failed")
    native.writableErrored = failure
    const destination = withoutForce(native)
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toBe(failure)
    expect(native.endCalls).toBe(0)
    expect(native.destroyCalls).toBe(0)
    expect(native.listenerCount("error")).toBe(0)
    expect(native.listenerCount("close")).toBe(0)
  })

  test("rejects a synchronous native close during listener registration", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    const registerOnce = destination.once.bind(destination)
    destination.once = function once(event, listener): FakeDestination {
      registerOnce(event, listener)
      if (event === "close") listener()
      return this
    }
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toMatchObject({
      name: "PinoDestinationClosedError",
      code: "GO_LIKE_PINO_DESTINATION_CLOSED"
    })
    expect(destination.endCalls).toBe(0)
    expect(destination.destroyCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
  })

  test("preserves a synchronous native error during listener registration", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    const failure = new Error("destination failed while installing listeners")
    const registerOn = destination.on.bind(destination)
    destination.on = function on(event, listener): FakeDestination {
      registerOn(event, listener)
      if (event === "error") listener(failure)
      return this
    }
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toBe(failure)
    expect(destination.endCalls).toBe(0)
    expect(destination.destroyCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
  })

  test("uses the canonical canceled sentinel before transfer", async () => {
    const destination = new FakeDestination()
    const logger = new FakeLogger()
    const startup = withCancelCause(background())
    startup[1](null)
    await expect(
      fakePinoServer(logger.official(destination), destination).start(startup[0])
    ).rejects.toBe(canceled)
    expect(destination.endCalls).toBe(0)
  })

  test("keeps a canceled stop caller local while the owner drain continues", async () => {
    const logger = new FakeLogger()
    logger.autoFlush = false
    const destination = new FakeDestination()
    const server = fakePinoServer(logger.official(destination), destination)
    const running = server.start(background())
    const caller = withCancelCause(background())
    const failure = new Error("caller left")
    caller[1](failure)

    await expect(server.stop(caller[0])).rejects.toBe(failure)
    expect(destination.endCalls).toBe(0)
    logger.callback?.()
    await running
    expect(destination.endCalls).toBe(1)
  })

  test("preserves a native flush callback failure and still ends the destination", async () => {
    const logger = new FakeLogger()
    const failure = new Error("flush failed")
    logger.flushError = failure
    const destination = new FakeDestination()
    const server = fakePinoServer(logger.official(destination), destination)
    const running = server.start(background())

    await expect(server.stop(background())).rejects.toBe(failure)
    await expect(running).rejects.toBe(failure)
    expect(destination.endCalls).toBe(1)
  })

  test("retains thrown flush and end values before the owner timeout", async () => {
    const logger = new FakeLogger()
    logger.flushThrown = "flush"
    const destination = new FakeDestination()
    destination.endThrown = "end"
    destination.autoClose = false
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(0))
    const running = server.start(background())

    const failure = (await server
      .stop(background())
      .catch((error: unknown) => error)) as AggregateError
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toHaveLength(3)
    expect(failure.errors[0].cause).toBe("flush")
    expect(failure.errors[1].cause).toBe("end")
    expect(failure.errors[2]).toMatchObject({ name: "PinoDrainTimeoutError" })
    expect(destination.destroyCalls).toBe(1)
    const terminalFailure = (await running.catch((error: unknown) => error)) as AggregateError
    expect(terminalFailure.errors).toEqual(failure.errors)
  })

  test("does not force an end failure before the Pino drain deadline", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    destination.endThrown = "end"
    destination.autoClose = false
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(10))
    const running = server.start(background())

    const stopping = server.stop(background())
    await delay()
    expect(destination.destroyCalls).toBe(0)
    const failure = (await stopping.catch((error: unknown) => error)) as AggregateError
    expect(failure.errors[0].cause).toBe("end")
    expect(failure.errors[1]).toMatchObject({ name: "PinoDrainTimeoutError" })
    expect(destination.destroyCalls).toBe(1)
    const terminalFailure = (await running.catch((error: unknown) => error)) as AggregateError
    expect(terminalFailure.errors).toEqual(failure.errors)
  })

  test("reports ordered native errors only after cleanup reaches close", async () => {
    const logger = new FakeLogger()
    const destination = new FakeDestination()
    const server = fakePinoServer(logger.official(destination), destination)
    const running = server.start(background())
    const first = new Error("first destination failure")
    const second = new Error("second destination failure")

    destination.fail(first)
    destination.fail(first)
    destination.fail(second)
    const failure = (await running.catch((error: unknown) => error)) as AggregateError
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([first, second])
    expect(destination.endCalls).toBe(1)
  })

  test("classifies an unexpected native close with the adapter error", async () => {
    const destination = new FakeDestination()
    const logger = new FakeLogger()
    const server = fakePinoServer(logger.official(destination), destination)
    const running = server.start(background())
    destination.close()
    await expect(running).rejects.toMatchObject({
      name: "PinoDestinationClosedError",
      code: "GO_LIKE_PINO_DESTINATION_CLOSED"
    })
  })

  test("uses optional native destroy only at the owner timeout boundary", async () => {
    const logger = new FakeLogger()
    logger.autoFlush = false
    const destination = new FakeDestination()
    destination.autoClose = false
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(0))
    const running = server.start(background())

    const failure: unknown = await server.stop(background()).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      name: "PinoDrainTimeoutError",
      timeoutMs: 0,
      forceSupported: true
    })
    expect(destination.destroyCalls).toBe(1)
    await expect(running).rejects.toBe(failure)
  })

  test("keeps terminal observation active when native destroy throws", async () => {
    const logger = new FakeLogger()
    logger.autoFlush = false
    const destination = new FakeDestination()
    destination.autoClose = false
    const destroyFailure = new Error("destroy failed")
    destination.destroyThrown = destroyFailure
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(0))
    const running = server.start(background())

    const failure = (await server
      .stop(background())
      .catch((error: unknown) => error)) as AggregateError
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors[0]).toMatchObject({ name: "PinoDrainTimeoutError" })
    expect(failure.errors[1]).toBe(destroyFailure)
    let terminalSettled = false
    void running.then(
      () => {
        terminalSettled = true
      },
      () => {
        terminalSettled = true
      }
    )
    await delay()
    expect(terminalSettled).toBeFalse()
    expect(destination.listenerCount("error")).toBe(1)
    expect(destination.listenerCount("close")).toBe(1)

    destination.close()
    const terminalFailure = (await running.catch((error: unknown) => error)) as AggregateError
    expect(terminalFailure).toBeInstanceOf(AggregateError)
    expect(terminalFailure.errors[0]).toBe(failure.errors[0])
    expect(terminalFailure.errors[1]).toBe(destroyFailure)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
  })

  test("keeps a ThreadStream-like terminal pending and observes late failure until close", async () => {
    const logger = new FakeLogger()
    logger.autoFlush = false
    const native = new FakeDestination()
    native.autoClose = false
    const destination = withoutForce(native)
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(0))
    const running = server.start(background())

    const failure = (await server
      .stop(background())
      .catch((error: unknown) => error)) as PinoDrainTimeoutError
    expect(failure.forceSupported).toBe(false)
    expect(native.destroyCalls).toBe(0)
    let terminalSettled = false
    void running.then(
      () => {
        terminalSettled = true
      },
      () => {
        terminalSettled = true
      }
    )
    await delay()
    expect(terminalSettled).toBeFalse()
    expect(native.listenerCount("error")).toBe(1)
    expect(native.listenerCount("close")).toBe(1)

    const lateFailure = new Error("late ThreadStream failure")
    native.fail(lateFailure)
    native.close()
    const terminalFailure = (await running.catch((error: unknown) => error)) as AggregateError
    expect(terminalFailure).toBeInstanceOf(AggregateError)
    expect(terminalFailure.errors).toEqual([failure, lateFailure])
    expect(native.listenerCount("error")).toBe(0)
    expect(native.listenerCount("close")).toBe(0)
  })

  test("keeps terminal pending when destroy returns without native close", async () => {
    const logger = new FakeLogger()
    logger.autoFlush = false
    const destination = new FakeDestination()
    destination.autoClose = false
    const staleClose: { callback?: () => void } = {}
    const registerOnce = destination.once.bind(destination)
    destination.once = function once(event, listener): FakeDestination {
      if (event === "close")
        staleClose.callback = () => {
          listener()
        }
      registerOnce(event, listener)
      return this
    }
    destination.destroy = function destroy(): void {
      this.destroyCalls += 1
      this.destroyed = true
    }
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(0))
    const running = server.start(background())

    const failure = (await server
      .stop(background())
      .catch((error: unknown) => error)) as PinoDrainTimeoutError
    expect(failure).toMatchObject({
      name: "PinoDrainTimeoutError",
      forceSupported: true
    })
    expect(destination.destroyCalls).toBe(1)
    const repeatedFailure = await server.stop(background()).catch((error: unknown) => error)
    expect(repeatedFailure).toBe(failure)
    expect(destination.destroyCalls).toBe(1)
    let terminalSettled = false
    void running.then(
      () => {
        terminalSettled = true
      },
      () => {
        terminalSettled = true
      }
    )
    await delay()
    expect(terminalSettled).toBeFalse()
    expect(destination.listenerCount("error")).toBe(1)
    expect(destination.listenerCount("close")).toBe(1)

    destination.close()
    await expect(running).rejects.toBe(failure)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
    const staleNativeClose = staleClose.callback
    if (staleNativeClose === undefined)
      throw new Error("Pino native close listener was not captured")

    staleNativeClose()
    await expect(running).rejects.toBe(failure)
    expect(destination.listenerCount("error")).toBe(0)
    expect(destination.listenerCount("close")).toBe(0)
  })

  test("rechecks elapsed monotonic time after a synchronous upstream stall", async () => {
    const logger = new FakeLogger()
    logger.blockForMs = 15
    logger.synchronousFlush = true
    const destination = new FakeDestination()
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(1))
    const running = server.start(background())

    await expect(server.stop(background())).rejects.toMatchObject({
      name: "PinoDrainTimeoutError",
      timeoutMs: 1
    })
    await expect(running).rejects.toMatchObject({
      name: "PinoDrainTimeoutError",
      timeoutMs: 1
    })
  })

  test("cleans a partially installed listener when native registration throws", async () => {
    const destination = new FakeDestination()
    const registrationFailure = new Error("close listener failed")
    destination.once = function once(): FakeDestination {
      throw registrationFailure
    }
    const logger = new FakeLogger()
    const server = fakePinoServer(logger.official(destination), destination)

    await expect(server.start(background())).rejects.toBe(registrationFailure)
    expect(destination.listenerCount("error")).toBe(0)
  })

  test("keeps the first owner stop stable during a synchronous native error re-entry", async () => {
    const destination = new FakeDestination()
    const logger = new FakeLogger()
    const failure = new Error("synchronous destination failure")
    logger.flush = function flush(callback?: (error?: Error) => void): void {
      this.flushCalls += 1
      destination.fail(failure)
      callback?.()
    }
    const server = fakePinoServer(logger.official(destination), destination)
    const running = server.start(background())

    await expect(server.stop(background())).rejects.toBe(failure)
    await expect(running).rejects.toBe(failure)
    expect(logger.flushCalls).toBe(1)
    expect(destination.endCalls).toBe(1)
  })

  test("ignores a stale hard-timeout callback after native drain succeeds", async () => {
    const destination = new FakeDestination()
    const logger = new FakeLogger()
    const server = fakePinoServer(logger.official(destination), destination, pinoDrainTimeout(100))
    const running = server.start(background())
    const originalSetTimeout = globalThis.setTimeout
    const captured: { callback?: () => void } = {}
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) => {
      if (typeof callback === "function")
        captured.callback = () => {
          callback(...arguments_)
        }
      return originalSetTimeout(callback, delay, ...arguments_)
    }) as typeof globalThis.setTimeout
    try {
      await server.stop(background())
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
    const timeoutCallback = captured.callback
    if (timeoutCallback === undefined)
      throw new Error("Pino hard-timeout callback was not captured")

    timeoutCallback()
    await running
    expect(destination.destroyCalls).toBe(0)
  })

  test("uses the observed Context error when an unregistered cause reader returns null", async () => {
    const destination = new FakeDestination()
    const logger = new FakeLogger()
    const failure = new Error("unstable external context")
    let errorReads = 0
    const externalContext = {
      deadline: (): readonly [Date, boolean] => [new Date(0), false],
      done: (): AbortSignal | null => null,
      err: (): Error | null => {
        errorReads += 1
        return errorReads === 1 ? failure : null
      },
      value: () => undefined
    }

    await expect(
      fakePinoServer(logger.official(destination), destination).start(externalContext)
    ).rejects.toBe(failure)
    expect(errorReads).toBe(2)
    expect(destination.listenerCount("error")).toBe(0)
  })

  test("normalizes a non-Error Context inspection failure without taking ownership", async () => {
    const destination = new FakeDestination()
    const logger = new FakeLogger()
    const server = fakePinoServer(logger.official(destination), destination)
    const failingContext = {
      deadline: (): readonly [Date, boolean] => [new Date(0), false],
      done: (): AbortSignal | null => null,
      err: (): Error | null => {
        throw "context failed"
      },
      value: () => undefined
    }

    await expect(server.start(failingContext)).rejects.toMatchObject({
      cause: "context failed"
    })
    expect(destination.listenerCount("error")).toBe(0)
  })
})
