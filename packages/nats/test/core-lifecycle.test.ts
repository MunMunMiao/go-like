import { describe, expect, test } from "bun:test"

import { background, canceled, withCancelCause, type Context } from "@go-like/context"
import { newApp, server as registerServer, stopTimeout as appStopTimeout } from "@go-like/core"
import type { Msg, Subscription } from "@nats-io/transport-node"
import {
  natsCoreDrainTimeout,
  newNatsCoreServer,
  type NatsCoreAlreadyStartedError,
  type NatsCoreDrainTimeoutError,
  type NatsCoreSubscriptionFactory,
  type NatsCoreUnexpectedExitError
} from "../src/index"

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

class FakeSubscription implements Subscription {
  readonly closedState = deferred<void | Error>()
  readonly closed = this.closedState.promise
  callback = () => {}
  drainCalls = 0
  unsubscribeCalls = 0
  iteratorCalls = 0
  closedFlag = false
  draining = false
  drainOperation: () => Promise<void> = async () => {
    this.finish()
  }
  unsubscribeOperation: () => void = () => {
    this.finish()
  };

  [Symbol.asyncIterator](): AsyncIterator<Msg> {
    this.iteratorCalls += 1
    return { next: async () => ({ done: true, value: undefined }) }
  }

  unsubscribe(): void {
    this.unsubscribeCalls += 1
    this.unsubscribeOperation()
  }

  drain(): Promise<void> {
    this.drainCalls += 1
    this.draining = true
    return this.drainOperation()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.drain()
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

  isDraining(): boolean {
    return this.draining
  }
  isClosed(): boolean {
    return this.closedFlag
  }
  getSubject(): string {
    return "events.created"
  }
  getReceived(): number {
    return 0
  }
  getProcessed(): number {
    return 0
  }
  getPending(): number {
    return 0
  }
  getID(): number {
    return 1
  }
  getMax(): number | undefined {
    return undefined
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

describe("NATS Core native Subscription lifecycle", () => {
  test("validates only the owner timeout option", () => {
    expect(() => natsCoreDrainTimeout(Number.NaN)).toThrow("integer from 0")
    expect(() => natsCoreDrainTimeout(-1)).toThrow("integer from 0")
    expect(() => natsCoreDrainTimeout(1.5)).toThrow("integer from 0")
    expect(() => natsCoreDrainTimeout(2_147_483_648)).toThrow("2147483647")
    expect(natsCoreDrainTimeout(0)).toBeFunction()
  })

  test("accepts a direct native Subscription, never consumes it, and is one-shot", async () => {
    const subscription = new FakeSubscription()
    const directServer = newNatsCoreServer(subscription)
    const directRunning = directServer.start(background())
    await nextTurn()

    expect(subscription.iteratorCalls).toBe(0)

    const server = newNatsCoreServer(new FakeSubscription())
    const firstRunning = server.start(background())
    await nextTurn()
    const error = (await server
      .start(background())
      .catch((value: unknown) => value)) as NatsCoreAlreadyStartedError
    expect(error).toMatchObject({
      name: "NatsCoreAlreadyStartedError",
      code: "GO_LIKE_NATS_CORE_ALREADY_STARTED",
      status: "running"
    })
    await server.stop(background())
    await firstRunning
    await directServer.stop(background())
    await directRunning
  })

  test("accepts an asynchronous factory once and reports a concurrent second start", async () => {
    const acquisition = deferred<Subscription>()
    let factoryCalls = 0
    const server = newNatsCoreServer(async () => {
      factoryCalls += 1
      return await acquisition.promise
    })
    const starting = server.start(background())
    await nextTurn()
    const error = (await server
      .start(background())
      .catch((value: unknown) => value)) as NatsCoreAlreadyStartedError
    expect(error.status).toBe("starting")
    const subscription = new FakeSubscription()
    acquisition.resolve(subscription)
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
    const server = newNatsCoreServer(() => {
      factoryCalls += 1
      return new FakeSubscription()
    })

    await expect(server.start(ctx)).rejects.toBe(cause)
    expect(factoryCalls).toBe(0)
    const error = (await server
      .start(background())
      .catch((value: unknown) => value)) as NatsCoreAlreadyStartedError
    expect(error.status).toBe("failed")
  })

  test("late factory acquisition is unsubscribed after the caller abandons startup", async () => {
    const acquisition = deferred<Subscription>()
    const [ctx, cancel] = withCancelCause(background())
    const cause = new Error("caller abandoned startup")
    const subscription = new FakeSubscription()
    const cleanupFailure = new Error("late unsubscribe failed")
    subscription.unsubscribeOperation = () => {
      throw cleanupFailure
    }
    const starting = newNatsCoreServer(() => acquisition.promise).start(ctx)
    await nextTurn()
    cancel(cause)
    await expect(starting).rejects.toBe(cause)
    acquisition.resolve(subscription)
    await nextTurn()
    expect(subscription.unsubscribeCalls).toBe(1)
  })

  test("successful late rollback preserves startup cancellation as the only failure", async () => {
    const acquisition = deferred<Subscription>()
    const [ctx, cancel] = withCancelCause(background())
    const cause = new Error("startup canceled")
    const subscription = new FakeSubscription()
    const starting = newNatsCoreServer(() => acquisition.promise).start(ctx)
    await nextTurn()
    cancel(cause)
    await expect(starting).rejects.toBe(cause)
    acquisition.resolve(subscription)
    await nextTurn()
    expect(subscription.unsubscribeCalls).toBe(1)
    await expect(subscription.closed).resolves.toBeUndefined()
  })

  test("an unaccepted direct Subscription remains untouched when acquisition is canceled", async () => {
    const subscription = new FakeSubscription()

    await expect(newNatsCoreServer(subscription).start(cancelAtAcquisition())).rejects.toBe(
      canceled
    )
    expect(subscription.unsubscribeCalls).toBe(0)
    expect(subscription.drainCalls).toBe(0)
    expect(subscription.isClosed()).toBeFalse()
  })

  test("an unaccepted direct Subscription remains untouched at final acceptance", async () => {
    const subscription = new FakeSubscription()

    await expect(newNatsCoreServer(subscription).start(cancelAtAcceptance())).rejects.toBe(canceled)
    expect(subscription.unsubscribeCalls).toBe(0)
    expect(subscription.drainCalls).toBe(0)
    expect(subscription.isClosed()).toBeFalse()
  })

  test("a final acceptance cancellation rolls back a factory-created Subscription", async () => {
    const subscription = new FakeSubscription()
    const cleanupFailure = new Error("unsubscribe failed")
    subscription.unsubscribeOperation = () => {
      throw cleanupFailure
    }
    const failure = await newNatsCoreServer(() => subscription)
      .start(cancelAtAcceptance())
      .catch((value: unknown) => value)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).cause).toBe(canceled)
    expect((failure as AggregateError).errors).toEqual([canceled, cleanupFailure])
    expect(subscription.unsubscribeCalls).toBe(1)
  })

  test("rejects invalid factory values and normalizes a non-Error factory rejection", async () => {
    const invalidValues: unknown[] = [null, 1, {}, { drain() {} }, { drain() {}, unsubscribe() {} }]
    for (const value of invalidValues) {
      const factory = (() => value) as unknown as NatsCoreSubscriptionFactory
      await expect(newNatsCoreServer(factory).start(background())).rejects.toThrow(
        "official Subscription"
      )
    }

    const rejection = await newNatsCoreServer((() =>
      Promise.reject("factory failed")) as NatsCoreSubscriptionFactory)
      .start(background())
      .catch((value: unknown) => value)
    expect(rejection).toMatchObject({
      message: "NATS Core startup rejected with a non-Error value",
      cause: "factory failed"
    })
  })

  test("caller cancellation abandons one stop wait but never cancels shared native drain", async () => {
    const subscription = new FakeSubscription()
    const drainGate = deferred<void>()
    subscription.drainOperation = async () => {
      await drainGate.promise
      subscription.finish()
    }
    const server = newNatsCoreServer(subscription)
    const running = server.start(background())
    await nextTurn()
    const [firstCtx, cancelFirst] = withCancelCause(background())
    const cause = new Error("first caller left")
    const first = server.stop(firstCtx)
    const second = server.stop(background())
    cancelFirst(cause)

    await expect(first).rejects.toBe(cause)
    expect(subscription.drainCalls).toBe(1)
    drainGate.resolve()
    await expect(second).resolves.toBeUndefined()
    await running
    expect(subscription.unsubscribeCalls).toBe(0)
  })

  test("timeout requests unsubscribe but cannot fabricate native terminal", async () => {
    const subscription = new FakeSubscription()
    const never = deferred<void>()
    subscription.drainOperation = () => never.promise
    subscription.unsubscribeOperation = () => {}
    const server = newNatsCoreServer(subscription, natsCoreDrainTimeout(0))
    const running = server.start(background())
    await nextTurn()
    const stopping = server.stop(background())
    const observedStopping = stopping.catch((value: unknown) => value)
    await nextTurn()

    expect(subscription.unsubscribeCalls).toBe(1)
    const failure = (await observedStopping) as NatsCoreDrainTimeoutError
    expect(failure).toMatchObject({
      name: "NatsCoreDrainTimeoutError",
      code: "GO_LIKE_NATS_CORE_DRAIN_TIMEOUT",
      timeoutMs: 0,
      forced: true
    })
    expect(await settleWithin(running, 20)).toBe("test-timeout")
    subscription.finish()
    expect(await settleWithin(running, 20)).toBe("test-timeout")
    const lateDrainFailure = new Error("late drain failure")
    never.reject(lateDrainFailure)
    const terminal = (await running.catch((value: unknown) => value)) as AggregateError
    expect(terminal).toBeInstanceOf(AggregateError)
    expect(terminal.errors).toEqual([failure, lateDrainFailure])
  })

  test("an elapsed synchronous drain call triggers the provider boundary", async () => {
    const subscription = new FakeSubscription()
    subscription.drainOperation = () => {
      block(5)
      return Promise.resolve()
    }
    const server = newNatsCoreServer(subscription, natsCoreDrainTimeout(1))
    const running = server.start(background())
    await nextTurn()
    const failure = await server.stop(background()).catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: "GO_LIKE_NATS_CORE_DRAIN_TIMEOUT" })
    expect(subscription.unsubscribeCalls).toBe(1)
    await expect(running).rejects.toBe(failure)
    await Bun.sleep(5)
    expect(subscription.unsubscribeCalls).toBe(1)
  })

  test("a resolved drain still waits for closed and can cross the provider boundary", async () => {
    const subscription = new FakeSubscription()
    subscription.drainOperation = async () => {}
    const server = newNatsCoreServer(subscription, natsCoreDrainTimeout(1))
    const running = server.start(background())
    await nextTurn()
    const failure = await server.stop(background()).catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: "GO_LIKE_NATS_CORE_DRAIN_TIMEOUT" })
    expect(subscription.unsubscribeCalls).toBe(1)
    await expect(running).rejects.toBe(failure)
  })

  test("preserves one exact native drain failure and deduplicates the same closed Error", async () => {
    const subscription = new FakeSubscription()
    const nativeFailure = new Error("native drain failed")
    subscription.drainOperation = () => {
      throw nativeFailure
    }
    subscription.unsubscribeOperation = () => {
      subscription.finish(nativeFailure)
    }
    const server = newNatsCoreServer(subscription)
    const running = server.start(background())
    await nextTurn()

    await expect(server.stop(background())).rejects.toBe(nativeFailure)
    await expect(running).rejects.toBe(nativeFailure)
  })

  test("aggregates normalized drain, unsubscribe, and closed failures in observation order", async () => {
    const subscription = new FakeSubscription()
    const unsubscribeFailure = new Error("unsubscribe failed")
    const closedFailure = new Error("closed failed")
    subscription.drainOperation = () => Promise.reject("drain failed")
    subscription.unsubscribeOperation = () => {
      throw unsubscribeFailure
    }
    const server = newNatsCoreServer(subscription)
    const running = server.start(background())
    await nextTurn()
    const stopping = server.stop(background())
    await nextTurn()
    subscription.finish(closedFailure)
    const failure = (await stopping.catch((value: unknown) => value)) as AggregateError

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toHaveLength(3)
    expect(failure.errors[0]).toMatchObject({
      message: "NATS Core drain rejected with a non-Error value",
      cause: "drain failed"
    })
    expect(failure.errors.slice(1)).toEqual([unsubscribeFailure, closedFailure])
    await expect(running).rejects.toEqual(failure)
  })

  test("reports passive native terminal without draining or consuming messages", async () => {
    const cases: Array<{
      finish(subscription: FakeSubscription): void
      expectedCause: Error | null | "normalized"
    }> = [
      {
        finish: (subscription) => {
          subscription.finish()
        },
        expectedCause: null
      },
      {
        finish: (subscription) => {
          subscription.finish(new Error("permissions"))
        },
        expectedCause: "normalized"
      },
      {
        finish: (subscription) => {
          subscription.failClosed("closed rejection")
        },
        expectedCause: "normalized"
      }
    ]

    for (const entry of cases) {
      const subscription = new FakeSubscription()
      const server = newNatsCoreServer(subscription)
      const running = server.start(background())
      await nextTurn()
      entry.finish(subscription)
      const failure = (await running.catch(
        (value: unknown) => value
      )) as NatsCoreUnexpectedExitError
      expect(failure).toMatchObject({
        name: "NatsCoreUnexpectedExitError",
        code: "GO_LIKE_NATS_CORE_UNEXPECTED_EXIT"
      })
      if (entry.expectedCause === null) expect(failure.cause).toBeNull()
      else expect(failure.cause).toBeInstanceOf(Error)
      await expect(server.stop(background())).rejects.toBe(failure)
      expect(subscription.drainCalls).toBe(0)
      expect(subscription.iteratorCalls).toBe(0)
    }
  })

  test("normalizes a throwing closed getter as passive native terminal", async () => {
    const closedFailure = new Error("closed getter failed")
    const source = {
      drain: async () => {},
      unsubscribe: () => {},
      get closed(): Promise<void | Error> {
        throw closedFailure
      }
    } as unknown as Subscription
    const server = newNatsCoreServer(source)
    const running = server.start(background())
    const failure = (await running.catch((value: unknown) => value)) as NatsCoreUnexpectedExitError
    expect(failure.cause).toBe(closedFailure)
  })

  test("accepts an already-closed object and immediately reports passive terminal", async () => {
    const subscription = new FakeSubscription()
    subscription.finish()
    const server = newNatsCoreServer(subscription)
    const running = server.start(background())
    const failure = await running.catch((value: unknown) => value)
    expect(failure).toMatchObject({ code: "GO_LIKE_NATS_CORE_UNEXPECTED_EXIT", cause: null })
    expect(subscription.drainCalls).toBe(0)
  })

  test("clears the provider-boundary timer after graceful native terminal", async () => {
    const subscription = new FakeSubscription()
    const server = newNatsCoreServer(subscription, natsCoreDrainTimeout(2))
    const running = server.start(background())
    await nextTurn()
    await server.stop(background())
    await running
    await Bun.sleep(5)
    expect(subscription.unsubscribeCalls).toBe(0)
  })

  test("integrates structurally with App while leaving message consumption to the application", async () => {
    const subscription = new FakeSubscription()
    const app = newApp(registerServer(newNatsCoreServer(subscription)), appStopTimeout(200))
    const running = app.run()
    await nextTurn()
    await app.stop()
    await running
    expect(subscription.drainCalls).toBe(1)
    expect(subscription.iteratorCalls).toBe(0)
  })
})
