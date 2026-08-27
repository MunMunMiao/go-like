import { describe, expect, test } from "bun:test"

import { background, canceled, withCancelCause, type Context } from "@go-like/context"
import { newApp, server as registerServer, stopTimeout as appStopTimeout } from "@go-like/core"
import type { ConsumerMessages, ConsumerNotification, JsMsg } from "@nats-io/jetstream"
import {
  natsJetStreamCloseTimeout,
  newNatsJetStreamServer,
  type NatsJetStreamAlreadyStartedError,
  type NatsJetStreamCloseTimeoutError,
  type NatsJetStreamMessagesFactory,
  type NatsJetStreamUnexpectedExitError
} from "../src/jetstream"

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

/** Blocks the only JavaScript thread to model a hostile synchronous native call. */
function block(timeoutMs: number): void {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    // Intentionally block timer dispatch until the native method returns.
  }
}

class FakeConsumerMessages implements ConsumerMessages {
  readonly closedState = deferred<void | Error>()
  closeCalls = 0
  stopCalls = 0
  iteratorCalls = 0
  closedFlag = false
  closeOperation: () => Promise<void | Error> = () => {
    this.finish()
    return this.closedState.promise
  }
  stopOperation: () => void = () => {
    this.finish()
  }
  closedOperation: () => Promise<void | Error> = () => this.closedState.promise;

  [Symbol.asyncIterator](): AsyncIterator<JsMsg> {
    this.iteratorCalls += 1
    return { next: async () => ({ done: true, value: undefined }) }
  }

  close(): Promise<void | Error> {
    this.closeCalls += 1
    return this.closeOperation()
  }

  closed(): Promise<void | Error> {
    return this.closedOperation()
  }

  stop(reason?: Error): void {
    this.stopCalls += 1
    this.stopOperation()
    void reason
  }

  finish(reason?: Error): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.closedState.resolve(reason)
  }

  failClosed(reason: unknown): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.closedState.reject(reason)
  }

  getProcessed(): number {
    return 0
  }
  getPending(): number {
    return 0
  }
  getReceived(): number {
    return 0
  }
  status(): AsyncIterable<ConsumerNotification> {
    return { async *[Symbol.asyncIterator]() {} }
  }
}

/** Returns a Context that becomes canceled at the final startup acceptance check. */
function cancelAtAcceptance(): Context {
  let reads = 0
  return {
    deadline: () => [new Date(0), false],
    done: () => null,
    err: () => {
      reads += 1
      return reads >= 3 ? canceled : null
    },
    value: () => undefined
  }
}

/** Returns a Context that becomes canceled while the source acquisition waiter starts. */
function cancelAtAcquisition(): Context {
  let reads = 0
  return {
    deadline: () => [new Date(0), false],
    done: () => null,
    err: () => {
      reads += 1
      return reads >= 2 ? canceled : null
    },
    value: () => undefined
  }
}

/** Waits for one promise without allowing a broken test to hang forever. */
async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs = 100
): Promise<PromiseSettledResult<T> | "test-timeout"> {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve("test-timeout")
    }, timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve({ status: "fulfilled", value })
      },
      (reason: unknown) => {
        clearTimeout(timeout)
        resolve({ status: "rejected", reason })
      }
    )
  })
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("NATS JetStream native ConsumerMessages lifecycle", () => {
  test("validates only the owner timeout option", () => {
    expect(() => natsJetStreamCloseTimeout(Number.NaN)).toThrow("integer from 0")
    expect(() => natsJetStreamCloseTimeout(-1)).toThrow("integer from 0")
    expect(() => natsJetStreamCloseTimeout(1.5)).toThrow("integer from 0")
    expect(() => natsJetStreamCloseTimeout(2_147_483_648)).toThrow("2147483647")
    expect(natsJetStreamCloseTimeout(0)).toBeFunction()
  })

  test("accepts direct ConsumerMessages, never consumes them, and is one-shot", async () => {
    const messages = new FakeConsumerMessages()
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    await nextTurn()

    expect(messages.iteratorCalls).toBe(0)
    const error = (await server
      .start(background())
      .catch((value: unknown) => value)) as NatsJetStreamAlreadyStartedError
    expect(error).toMatchObject({
      name: "NatsJetStreamAlreadyStartedError",
      code: "GO_LIKE_NATS_JETSTREAM_ALREADY_STARTED",
      status: "running"
    })
    await server.stop(background())
    await running
  })

  test("accepts an asynchronous factory once and reports a concurrent second start", async () => {
    const acquisition = deferred<ConsumerMessages>()
    let factoryCalls = 0
    const server = newNatsJetStreamServer(async () => {
      factoryCalls += 1
      return await acquisition.promise
    })
    const starting = server.start(background())
    await nextTurn()
    const error = (await server
      .start(background())
      .catch((value: unknown) => value)) as NatsJetStreamAlreadyStartedError
    expect(error.status).toBe("starting")
    const messages = new FakeConsumerMessages()
    acquisition.resolve(messages)
    await nextTurn()
    expect(factoryCalls).toBe(1)
    await server.stop(background())
    await starting
  })

  test("a pre-canceled start never invokes the factory and consumes the one-shot server", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const cause = new Error("already canceled")
    cancel(cause)
    let factoryCalls = 0
    const server = newNatsJetStreamServer(() => {
      factoryCalls += 1
      return new FakeConsumerMessages()
    })

    await expect(server.start(ctx)).rejects.toBe(cause)
    expect(factoryCalls).toBe(0)
    const error = (await server
      .start(background())
      .catch((value: unknown) => value)) as NatsJetStreamAlreadyStartedError
    expect(error.status).toBe("failed")
  })

  test("late factory acquisition is stopped after the caller abandons startup", async () => {
    const acquisition = deferred<ConsumerMessages>()
    const [ctx, cancel] = withCancelCause(background())
    const cause = new Error("caller abandoned startup")
    const messages = new FakeConsumerMessages()
    const cleanupFailure = new Error("late stop failed")
    messages.stopOperation = () => {
      throw cleanupFailure
    }
    const starting = newNatsJetStreamServer(() => acquisition.promise).start(ctx)
    await nextTurn()
    cancel(cause)
    await expect(starting).rejects.toBe(cause)
    acquisition.resolve(messages)
    await nextTurn()
    expect(messages.stopCalls).toBe(1)
  })

  test("successful late rollback preserves startup cancellation as the only failure", async () => {
    const acquisition = deferred<ConsumerMessages>()
    const [ctx, cancel] = withCancelCause(background())
    const cause = new Error("startup canceled")
    const messages = new FakeConsumerMessages()
    const starting = newNatsJetStreamServer(() => acquisition.promise).start(ctx)
    await nextTurn()
    cancel(cause)
    await expect(starting).rejects.toBe(cause)
    acquisition.resolve(messages)
    await nextTurn()
    expect(messages.stopCalls).toBe(1)
    await expect(messages.closed()).resolves.toBeUndefined()
  })

  test("unaccepted direct ConsumerMessages remain untouched when acquisition is canceled", async () => {
    const messages = new FakeConsumerMessages()

    await expect(newNatsJetStreamServer(messages).start(cancelAtAcquisition())).rejects.toBe(
      canceled
    )
    expect(messages.stopCalls).toBe(0)
    expect(messages.closeCalls).toBe(0)
    expect(messages.closedFlag).toBeFalse()
  })

  test("unaccepted direct ConsumerMessages remain untouched at final acceptance", async () => {
    const messages = new FakeConsumerMessages()

    await expect(newNatsJetStreamServer(messages).start(cancelAtAcceptance())).rejects.toBe(
      canceled
    )
    expect(messages.stopCalls).toBe(0)
    expect(messages.closeCalls).toBe(0)
    expect(messages.closedFlag).toBeFalse()
  })

  test("a final acceptance cancellation rolls back factory-created ConsumerMessages", async () => {
    const messages = new FakeConsumerMessages()
    const cleanupFailure = new Error("stop failed")
    messages.stopOperation = () => {
      throw cleanupFailure
    }
    const failure = await newNatsJetStreamServer(() => messages)
      .start(cancelAtAcceptance())
      .catch((value: unknown) => value)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).cause).toBe(canceled)
    expect((failure as AggregateError).errors).toEqual([canceled, cleanupFailure])
    expect(messages.stopCalls).toBe(1)
  })

  test("rejects invalid factory values and normalizes a non-Error factory rejection", async () => {
    const invalidValues: unknown[] = [
      null,
      1,
      {},
      { close() {} },
      { close() {}, closed() {} },
      { close() {}, closed: true, stop() {} }
    ]
    for (const value of invalidValues) {
      const factory = (() => value) as unknown as NatsJetStreamMessagesFactory
      await expect(newNatsJetStreamServer(factory).start(background())).rejects.toThrow(
        "official ConsumerMessages"
      )
    }

    const rejection = await newNatsJetStreamServer((() =>
      Promise.reject("factory failed")) as NatsJetStreamMessagesFactory)
      .start(background())
      .catch((value: unknown) => value)
    expect(rejection).toMatchObject({
      message: "NATS JetStream startup rejected with a non-Error value",
      cause: "factory failed"
    })
  })

  test("caller cancellation abandons one stop wait but never cancels shared native close", async () => {
    const messages = new FakeConsumerMessages()
    const closeGate = deferred<void>()
    messages.closeOperation = async () => {
      await closeGate.promise
      messages.finish()
    }
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    await nextTurn()
    const [firstCtx, cancelFirst] = withCancelCause(background())
    const cause = new Error("first caller left")
    const first = server.stop(firstCtx)
    const second = server.stop(background())
    cancelFirst(cause)

    await expect(first).rejects.toBe(cause)
    expect(messages.closeCalls).toBe(1)
    closeGate.resolve()
    await expect(second).resolves.toBeUndefined()
    await running
    expect(messages.stopCalls).toBe(0)
  })

  test("timeout requests stop but cannot fabricate native terminal", async () => {
    const messages = new FakeConsumerMessages()
    const never = deferred<void | Error>()
    messages.closeOperation = () => never.promise
    messages.stopOperation = () => {}
    const server = newNatsJetStreamServer(messages, natsJetStreamCloseTimeout(0))
    const running = server.start(background())
    await nextTurn()
    const stopping = server.stop(background())
    const observedStopping = stopping.catch((value: unknown) => value)
    await nextTurn()

    expect(messages.stopCalls).toBe(1)
    const failure = (await observedStopping) as NatsJetStreamCloseTimeoutError
    expect(failure).toMatchObject({
      name: "NatsJetStreamCloseTimeoutError",
      code: "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT",
      timeoutMs: 0,
      forced: true
    })
    expect(await settleWithin(running, 20)).toBe("test-timeout")
    messages.finish()
    expect(await settleWithin(running, 20)).toBe("test-timeout")
    const lateCloseFailure = new Error("late close failure")
    never.reject(lateCloseFailure)
    const terminal = (await running.catch((value: unknown) => value)) as AggregateError
    expect(terminal).toBeInstanceOf(AggregateError)
    expect(terminal.errors).toEqual([failure, lateCloseFailure])
  })

  test("an elapsed synchronous close call triggers the provider boundary", async () => {
    const messages = new FakeConsumerMessages()
    messages.closeOperation = () => {
      block(5)
      return Promise.resolve()
    }
    const server = newNatsJetStreamServer(messages, natsJetStreamCloseTimeout(1))
    const running = server.start(background())
    await nextTurn()
    const failure = await server.stop(background()).catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT" })
    expect(messages.stopCalls).toBe(1)
    await expect(running).rejects.toBe(failure)
    await Bun.sleep(5)
    expect(messages.stopCalls).toBe(1)
  })

  test("a resolved close still waits for closed and can cross the provider boundary", async () => {
    const messages = new FakeConsumerMessages()
    messages.closeOperation = async () => {}
    const server = newNatsJetStreamServer(messages, natsJetStreamCloseTimeout(1))
    const running = server.start(background())
    await nextTurn()
    const failure = await server.stop(background()).catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT" })
    expect(messages.stopCalls).toBe(1)
    await expect(running).rejects.toBe(failure)
  })

  test("preserves one exact native close Error and deduplicates the same closed Error", async () => {
    const messages = new FakeConsumerMessages()
    const nativeFailure = new Error("native close failed")
    messages.closeOperation = async () => {
      messages.finish(nativeFailure)
      return nativeFailure
    }
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    await nextTurn()

    await expect(server.stop(background())).rejects.toBe(nativeFailure)
    await expect(running).rejects.toBe(nativeFailure)
    expect(messages.stopCalls).toBe(1)
  })

  test("preserves a synchronous native close throw after native stop reaches terminal", async () => {
    const messages = new FakeConsumerMessages()
    const nativeFailure = new Error("synchronous close failure")
    messages.closeOperation = () => {
      throw nativeFailure
    }
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    await nextTurn()

    await expect(server.stop(background())).rejects.toBe(nativeFailure)
    await expect(running).rejects.toBe(nativeFailure)
    expect(messages.stopCalls).toBe(1)
  })

  test("aggregates normalized close, stop, and closed failures in observation order", async () => {
    const messages = new FakeConsumerMessages()
    const stopFailure = new Error("stop failed")
    const closedFailure = new Error("closed failed")
    messages.closeOperation = () => Promise.reject("close failed")
    messages.stopOperation = () => {
      throw stopFailure
    }
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    await nextTurn()
    const stopping = server.stop(background())
    await nextTurn()
    messages.finish(closedFailure)
    const failure = (await stopping.catch((value: unknown) => value)) as AggregateError

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toHaveLength(3)
    expect(failure.errors[0]).toMatchObject({
      message: "NATS JetStream close rejected with a non-Error value",
      cause: "close failed"
    })
    expect(failure.errors.slice(1)).toEqual([stopFailure, closedFailure])
    await expect(running).rejects.toEqual(failure)
  })

  test("reports passive native terminal without closing, stopping, or consuming messages", async () => {
    const cases: Array<(messages: FakeConsumerMessages) => void> = [
      (messages) => {
        messages.finish()
      },
      (messages) => {
        messages.finish(new Error("consumer deleted"))
      },
      (messages) => {
        messages.failClosed("closed rejection")
      }
    ]

    for (const finish of cases) {
      const messages = new FakeConsumerMessages()
      const server = newNatsJetStreamServer(messages)
      const running = server.start(background())
      await nextTurn()
      finish(messages)
      const failure = (await running.catch(
        (value: unknown) => value
      )) as NatsJetStreamUnexpectedExitError
      expect(failure).toMatchObject({
        name: "NatsJetStreamUnexpectedExitError",
        code: "GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT"
      })
      await expect(server.stop(background())).rejects.toBe(failure)
      expect(messages.closeCalls).toBe(0)
      expect(messages.stopCalls).toBe(0)
      expect(messages.iteratorCalls).toBe(0)
    }
  })

  test("normalizes a throwing closed method as passive native terminal", async () => {
    const messages = new FakeConsumerMessages()
    const closedFailure = new Error("closed method failed")
    messages.closedOperation = () => {
      throw closedFailure
    }
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    const failure = (await running.catch(
      (value: unknown) => value
    )) as NatsJetStreamUnexpectedExitError
    expect(failure.cause).toBe(closedFailure)
  })

  test("accepts already-closed ConsumerMessages and immediately reports passive terminal", async () => {
    const messages = new FakeConsumerMessages()
    messages.finish()
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    const failure = await running.catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: "GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT", cause: null })
    expect(messages.closeCalls).toBe(0)
  })

  test("clears the provider-boundary timer after graceful native terminal", async () => {
    const messages = new FakeConsumerMessages()
    const server = newNatsJetStreamServer(messages, natsJetStreamCloseTimeout(2))
    const running = server.start(background())
    await nextTurn()
    await server.stop(background())
    await running
    await Bun.sleep(5)
    expect(messages.stopCalls).toBe(0)
  })

  test("integrates structurally with App while leaving iteration and ack to the application", async () => {
    const messages = new FakeConsumerMessages()
    const app = newApp(registerServer(newNatsJetStreamServer(messages)), appStopTimeout(200))
    const running = app.run()
    await nextTurn()
    await app.stop()
    await running
    expect(messages.closeCalls).toBe(1)
    expect(messages.iteratorCalls).toBe(0)
  })
})
