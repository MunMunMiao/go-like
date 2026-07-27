import { describe, expect, test } from "bun:test"
import { background, canceled, withCancelCause, withTimeout, type Context } from "@likego/context"
import type { Server } from "@likego/core"

import { newWinstonServer } from "../src/index"
import { FakeLogger, turns } from "./helpers"

describe("native Winston logger lifecycle", () => {
  test("construction validates without observing or taking over the logger", () => {
    const logger = new FakeLogger()

    newWinstonServer(logger.official())

    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
  })

  test("accepts an existing logger and ends it exactly once before finish", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server: Server = newWinstonServer(logger.official())
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
    const running = server.start(background())
    expect(logger.listenerCount("error")).toBe(1)
    expect(logger.listenerCount("finish")).toBe(1)
    expect(logger.listenerCount("close")).toBe(1)
    const done = running
    expect(running).toBe(done)

    const stopping = server.stop(background())
    await turns()
    expect(logger.endCalls).toBe(1)
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await turns()
    expect(settled).toBeFalse()

    logger.finish()
    await Promise.all([stopping, done, server.stop(background())])
    expect(logger.endCalls).toBe(1)
  })

  test("keeps cancellation local to one stop waiter while owner drain continues", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const caller = withCancelCause(background())
    const failure = new Error("caller left")
    const stopping = server.stop(caller[0])
    caller[1](failure)

    await expect(stopping).rejects.toBe(failure)
    expect(logger.endCalls).toBe(1)
    logger.finish()
    await running
  })

  test("preserves native logger error identity and waits for finish", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const failure = new Error("transport failed")

    logger.fail(failure)
    await turns()
    expect(logger.endCalls).toBe(1)
    logger.finish()
    await expect(running).rejects.toBe(failure)
  })

  test("aggregates distinct native errors in observation order", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const first = new Error("first")
    const second = new Error("second")

    logger.fail(first)
    logger.fail(first)
    logger.fail(second)
    logger.finish()
    const failure = await running.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([first, second])
  })

  test("classifies finish before owner stop as an unexpected terminal", async () => {
    const logger = new FakeLogger()
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    logger.finish()
    await expect(running).rejects.toMatchObject({
      name: "WinstonLoggerFinishedError",
      code: "LIKEGO_WINSTON_LOGGER_FINISHED"
    })
    expect(logger.endCalls).toBe(0)
  })

  test("classifies close before finish as an unexpected terminal", async () => {
    const logger = new FakeLogger()
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    logger.close()
    await expect(running).rejects.toMatchObject({
      name: "WinstonLoggerClosedError",
      code: "LIKEGO_WINSTON_LOGGER_CLOSED"
    })
    expect(logger.endCalls).toBe(0)
  })

  test("preserves an end invocation failure without calling close", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const failure = new Error("end failed")
    logger.endThrown = failure
    const server = newWinstonServer(logger.official())
    const running = server.start(background())

    const stopping = server.stop(background())
    await turns()
    expect(logger.endCalls).toBe(1)
    expect(logger.closed).toBeFalse()
    logger.finish()
    await expect(stopping).rejects.toBe(failure)
    await expect(running).rejects.toBe(failure)
  })

  test("normalizes non-Error error events and end throws", async () => {
    const eventLogger = new FakeLogger()
    eventLogger.autoFinish = false
    const eventServer = newWinstonServer(eventLogger.official())
    const eventRunning = eventServer.start(background())
    eventLogger.fail("transport")
    eventLogger.finish()
    await expect(eventRunning).rejects.toMatchObject({ cause: "transport" })

    const endLogger = new FakeLogger()
    endLogger.autoFinish = false
    endLogger.endThrown = "end"
    const endServer = newWinstonServer(endLogger.official())
    const endRunning = endServer.start(background())
    const ending = endServer.stop(background())
    await turns()
    endLogger.finish()
    await expect(ending).rejects.toMatchObject({ cause: "end" })
    await expect(endRunning).rejects.toMatchObject({ cause: "end" })
  })

  test("waits for a real terminal when close interrupts owner drain", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const stopping = server.stop(background())
    await turns()
    logger.close()
    await expect(stopping).rejects.toMatchObject({
      name: "WinstonLoggerClosedError"
    })
  })

  test("pre-canceled startup has no logger side effect and consumes the server", async () => {
    const logger = new FakeLogger()
    const server = newWinstonServer(logger.official())
    const startup = withCancelCause(background())
    const failure = new Error("startup canceled")
    startup[1](failure)

    await expect(server.start(startup[0])).rejects.toBe(failure)
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
    await expect(server.start(background())).rejects.toMatchObject({
      name: "WinstonAlreadyStartedError",
      status: "failed"
    })
  })

  test("uses the canonical canceled sentinel without a custom cause", async () => {
    const logger = new FakeLogger()
    const startup = withCancelCause(background())
    startup[1](null)
    await expect(newWinstonServer(logger.official()).start(startup[0])).rejects.toBe(canceled)
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
  })

  test("preserves the first err read when an external Context cause read becomes null", async () => {
    const logger = new FakeLogger()
    const failure = new Error("unstable external context")
    let errorReads = 0
    const startup: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal | null {
        return null
      },
      err(): Error | null {
        errorReads += 1
        return errorReads === 1 ? failure : null
      },
      value(): unknown {
        return null
      }
    })

    await expect(newWinstonServer(logger.official()).start(startup)).rejects.toBe(failure)
    expect(errorReads).toBe(2)
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
  })

  test("rejects finish or close state observed only when startup is attempted", async () => {
    const finishedLogger = new FakeLogger()
    const finished = newWinstonServer(finishedLogger.official())
    expect(finishedLogger.listenerCount("finish")).toBe(0)
    finishedLogger.finish()
    await expect(finished.start(background())).rejects.toMatchObject({
      name: "WinstonLoggerFinishedError"
    })

    const closedLogger = new FakeLogger()
    const closed = newWinstonServer(closedLogger.official())
    expect(closedLogger.listenerCount("close")).toBe(0)
    closedLogger.close()
    await expect(closed.start(background())).rejects.toMatchObject({
      name: "WinstonLoggerClosedError"
    })
    expect(closedLogger.endCalls).toBe(0)
  })

  test("rolls back every listener when installation fails part way through", async () => {
    const logger = new FakeLogger()
    const registrationFailure = new Error("close listener failed")
    const nativeOnce = logger.once
    let onceCalls = 0
    logger.once = function once(event, listener): FakeLogger {
      onceCalls += 1
      if (onceCalls === 2) throw registrationFailure
      nativeOnce.call(this, event, listener)
      return this
    }
    const server = newWinstonServer(logger.official())

    await expect(server.start(background())).rejects.toBe(registrationFailure)
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
  })

  test("rejects a synchronous finish emitted while its listener is being installed", async () => {
    const logger = new FakeLogger()
    const nativeOnce = logger.once
    logger.once = function once(event, listener): FakeLogger {
      const registered = nativeOnce.call(this, event, listener)
      if (event === "finish") this.emit("finish")
      return registered
    }

    await expect(newWinstonServer(logger.official()).start(background())).rejects.toMatchObject({
      name: "WinstonLoggerFinishedError",
      code: "LIKEGO_WINSTON_LOGGER_FINISHED"
    })
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
  })

  test("rejects a synchronous close emitted while its listener is being installed", async () => {
    const logger = new FakeLogger()
    const nativeOnce = logger.once
    logger.once = function once(event, listener): FakeLogger {
      const registered = nativeOnce.call(this, event, listener)
      if (event === "close") this.emit("close")
      return registered
    }

    await expect(newWinstonServer(logger.official()).start(background())).rejects.toMatchObject({
      name: "WinstonLoggerClosedError",
      code: "LIKEGO_WINSTON_LOGGER_CLOSED"
    })
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
  })

  test("ignores stale duplicate native terminal callbacks without changing failure identity", async () => {
    const logger = new FakeLogger()
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const done = running

    logger.finish()
    const failure = await done.catch(function observeFailure(error: unknown) {
      return error
    })
    logger.invokeRetained("finish")
    logger.invokeRetained("close")
    logger.invokeRetained("close")

    await expect(running).rejects.toBe(failure)
    expect(logger.endCalls).toBe(0)
    expect(logger.listenerCount("error")).toBe(0)
    expect(logger.listenerCount("finish")).toBe(0)
    expect(logger.listenerCount("close")).toBe(0)
  })

  test("caller Context timeout never fabricates the shared native terminal", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const stopCtx = withTimeout(background(), 1)[0]

    await expect(server.stop(stopCtx)).rejects.toThrow()
    expect(logger.endCalls).toBe(1)
    const outcome = await Promise.race([
      running.then(
        () => "settled" as const,
        () => "settled" as const
      ),
      new Promise<"pending">((resolve) => {
        setTimeout(() => {
          resolve("pending")
        }, 10)
      })
    ])
    expect(outcome).toBe("pending")

    logger.finish()
    await running
  })

  test("leaves a missing native terminal pending without fabricating completion", async () => {
    const logger = new FakeLogger()
    logger.autoFinish = false
    const server = newWinstonServer(logger.official())
    const running = server.start(background())
    const stopping = server.stop(background())
    await turns()

    expect(logger.endCalls).toBe(1)
    expect(logger.listenerCount("finish")).toBe(1)
    const outcome = await Promise.race([
      running.then(
        () => "settled" as const,
        () => "settled" as const
      ),
      turns().then(() => "pending" as const)
    ])
    expect(outcome).toBe("pending")

    logger.finish()
    await Promise.all([stopping, running])
    expect(logger.listenerCount("finish")).toBe(0)
  })

  test("rejects loggers already finished or closed before lifecycle transfer", async () => {
    const finishedLogger = new FakeLogger()
    finishedLogger.finish()
    await expect(
      newWinstonServer(finishedLogger.official()).start(background())
    ).rejects.toMatchObject({
      name: "WinstonLoggerFinishedError"
    })

    const closedLogger = new FakeLogger()
    closedLogger.close()
    await expect(
      newWinstonServer(closedLogger.official()).start(background())
    ).rejects.toMatchObject({
      name: "WinstonLoggerClosedError"
    })
  })
})
