import { expect, test } from "bun:test"

import { background, canceled, withCancel } from "@likego/context"
import type { Context } from "@likego/context"

import * as ListenerTesting from "../src/listener"
import type {
  ListenerConformanceHandle,
  ListenerFactory,
  ListenerLifecycleConformanceHandle
} from "../src/listener"

const listenerConformanceCases: (
  factory: ListenerFactory
) => readonly { readonly name: string; run(): Promise<void> }[] = Reflect.get(
  ListenerTesting,
  "listenerConformanceCases"
)

interface FixtureControl {
  readonly handle: ListenerLifecycleConformanceHandle
  readonly closeCalls: () => number
}

function newFixture(): FixtureControl {
  let closeCalls = 0
  let resolveDone: (() => void) | null = null
  let rejectDone: ((error: Error) => void) | null = null
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  let cleanup: Promise<void> | null = null
  const handle: ListenerLifecycleConformanceHandle = {
    address(): string {
      return "127.0.0.1:43123"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx: Context): Promise<void> {
      closeCalls += 1
      if (cleanup === null) {
        cleanup = Promise.resolve().then(() => {
          if (resolveDone === null) throw new Error("listener fixture resolver is missing")
          resolveDone()
        })
      }
      const failure = ctx.err()
      return failure === null ? cleanup : Promise.reject(failure)
    },
    ready(): Promise<void> {
      return Promise.resolve()
    },
    force(): Promise<void> {
      if (cleanup === null) {
        cleanup = Promise.resolve().then(() => {
          if (resolveDone === null) throw new Error("listener fixture resolver is missing")
          resolveDone()
        })
      }
      return cleanup
    },
    fail(error: Error): void {
      rejectDone?.(error)
    },
    rebind(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { handle, closeCalls: () => closeCalls }
}

function implementationAvailable(): boolean {
  const available = typeof listenerConformanceCases === "function"
  expect(available).toBe(true)
  return available
}

function conformanceCase(name: string, factory: ListenerFactory) {
  const found = listenerConformanceCases(factory).find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`missing listener conformance case: ${name}`)
  return found
}

test("listener subpath exports only the runner-neutral conformance factory", () => {
  expect(Object.keys(ListenerTesting)).toEqual(["listenerConformanceCases"])
})

test("publishes the frozen listener conformance inventory", () => {
  if (!implementationAvailable()) return
  expect(listenerConformanceCases(() => newFixture().handle).map((entry) => entry.name)).toEqual([
    "listener exposes one stable non-empty address",
    "listener exposes one stable done promise",
    "listener close is idempotent and resolves done",
    "pre-canceled and started close callers do not cancel shared listener cleanup",
    "listener readiness follows real bind",
    "listener force converges on stable done",
    "passive listener failure preserves Error identity",
    "listener terminal releases its bound port"
  ])
})

test("rejects a non-callable listener factory at the public boundary", () => {
  if (!implementationAvailable()) return
  expect(() => Reflect.apply(listenerConformanceCases, undefined, [null])).toThrow(
    "listener conformance factory must be a function"
  )
})

test("validates the complete structural listener handle in every case", async () => {
  if (!implementationAvailable()) return
  const done = Promise.resolve()
  const malformed = {
    address: 42,
    done(): Promise<void> {
      return done
    },
    close(): Promise<void> {
      return done
    }
  }
  const cases = listenerConformanceCases(() => malformed as never)
  for (const entry of cases) {
    await expect(entry.run()).rejects.toThrow("listener address must be a function")
  }

  const malformedHandles = [
    {
      value: null,
      message: "listener conformance factory must return an object"
    },
    {
      value: {
        address(): string {
          return "127.0.0.1:1"
        },
        done: null,
        close(): Promise<void> {
          return done
        }
      },
      message: "listener done must be a function"
    },
    {
      value: {
        address(): string {
          return "127.0.0.1:1"
        },
        done(): Promise<void> {
          return done
        },
        close: null
      },
      message: "listener close must be a function"
    }
  ]
  for (const malformedHandle of malformedHandles) {
    const found = listenerConformanceCases(() => malformedHandle.value as never)[0]
    if (found === undefined) throw new Error("missing listener admission case")
    await expect(found.run()).rejects.toThrow(malformedHandle.message)
  }
})

test("captures listener handle callables once with their original receiver", async () => {
  if (!implementationAvailable()) return
  const terminal = Promise.resolve()
  const reads = { address: 0, done: 0, close: 0 }
  const receivers: boolean[] = []
  const subject = {
    marker: "original",
    get address(): () => string {
      reads.address += 1
      return function capturedAddress(this: { marker: string }): string {
        receivers.push(this === subject)
        return `${this.marker}:127.0.0.1:1`
      }
    },
    get done(): () => Promise<void> {
      reads.done += 1
      return function capturedDone(this: { marker: string }): Promise<void> {
        receivers.push(this === subject)
        return terminal
      }
    },
    get close(): (ctx: Context) => Promise<void> {
      reads.close += 1
      return function capturedClose(this: { marker: string }, ctx: Context): Promise<void> {
        receivers.push(this === subject)
        const failure = ctx.err()
        return failure === null ? terminal : Promise.reject(failure)
      }
    }
  }
  const found = listenerConformanceCases(() => subject).find(
    (entry) => entry.name === "listener exposes one stable non-empty address"
  )
  if (found === undefined) throw new Error("missing listener receiver case")
  await found.run()
  expect(reads).toEqual({ address: 1, done: 1, close: 1 })
  expect(receivers.every(Boolean)).toBe(true)
})

test("rejects a non-string address and a non-PromiseLike terminal", async () => {
  if (!implementationAvailable()) return
  const nonStringAddress = {
    address(): unknown {
      return 42
    },
    done(): Promise<void> {
      return Promise.resolve()
    },
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  await expect(
    conformanceCase(
      "listener exposes one stable non-empty address",
      () => nonStringAddress as never
    ).run()
  ).rejects.toThrow("Listener address must be a stable non-empty string")

  const nonPromiseDone = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): undefined {
      return undefined
    },
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  let nonPromiseFailure: unknown = null
  try {
    await conformanceCase(
      "listener exposes one stable done promise",
      () => nonPromiseDone as never
    ).run()
  } catch (failure) {
    nonPromiseFailure = failure
  }
  expect(nonPromiseFailure).toBeInstanceOf(AggregateError)
  if (!(nonPromiseFailure instanceof AggregateError))
    throw new Error("expected done validation AggregateError")
  expect(nonPromiseFailure.errors[0]).toMatchObject({
    message: "Listener done must return a PromiseLike"
  })

  const nonPromiseClose = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return Promise.resolve()
    },
    close(): undefined {
      return undefined
    }
  }
  await expect(
    conformanceCase(
      "listener exposes one stable non-empty address",
      () => nonPromiseClose as never
    ).run()
  ).rejects.toThrow("Listener close must return a PromiseLike")
})

test("accepts a stable cross-realm-style PromiseLike terminal", async () => {
  if (!implementationAvailable()) return
  function freshSubject(): ListenerLifecycleConformanceHandle {
    let resolveTerminal: (() => void) | null = null
    let rejectTerminal: ((error: Error) => void) | null = null
    const terminal = new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve
      rejectTerminal = reject
    })
    const terminalLike: PromiseLike<void> = {
      then(onfulfilled, onrejected) {
        return terminal.then(onfulfilled, onrejected)
      }
    }
    const ready = Promise.resolve()
    const readyLike: PromiseLike<void> = {
      then(onfulfilled, onrejected) {
        return ready.then(onfulfilled, onrejected)
      }
    }
    return {
      address(): string {
        return "127.0.0.1:1"
      },
      done(): PromiseLike<void> {
        return terminalLike
      },
      close(ctx: Context): PromiseLike<void> {
        const failure = ctx.err()
        if (failure !== null) return Promise.reject(failure)
        resolveTerminal?.()
        return terminalLike
      },
      ready(): PromiseLike<void> {
        return readyLike
      },
      force(): PromiseLike<void> {
        resolveTerminal?.()
        return readyLike
      },
      fail(error: Error): void {
        rejectTerminal?.(error)
      },
      rebind(): PromiseLike<void> {
        return readyLike
      }
    }
  }
  for (const entry of listenerConformanceCases(freshSubject)) {
    await expect(entry.run()).resolves.toBeUndefined()
  }
})

test("passes every listener case for a structural implementation", async () => {
  if (!implementationAvailable()) return
  let factories = 0
  const cases = listenerConformanceCases(() => {
    factories += 1
    return newFixture().handle
  })

  for (const entry of cases) await entry.run()
  expect(factories).toBe(cases.length)
})

test("validates executable lifecycle probes and readiness identity", async () => {
  if (!implementationAvailable()) return
  await expect(
    conformanceCase("listener readiness follows real bind", () => null as never).run()
  ).rejects.toThrow("listener conformance factory must return an object")

  const missingReady = newFixture().handle
  const withoutReady = {
    address: missingReady.address,
    done: missingReady.done,
    close: missingReady.close,
    force: missingReady.force,
    fail: missingReady.fail,
    rebind: missingReady.rebind
  }
  await expect(
    conformanceCase("listener readiness follows real bind", () => withoutReady as never).run()
  ).rejects.toThrow("listener lifecycle ready must be a function")

  const invalidFail = newFixture().handle
  const invalidFailResult = {
    ...invalidFail,
    fail(): number {
      return 42
    }
  }
  await expect(
    conformanceCase(
      "passive listener failure preserves Error identity",
      () => invalidFailResult as never
    ).run()
  ).rejects.toThrow("listener lifecycle fail must return void or a PromiseLike")

  const unstableReady = newFixture().handle
  let ready = false
  const changedAddress = {
    ...unstableReady,
    address(): string {
      return ready ? "127.0.0.1:2" : "127.0.0.1:1"
    },
    ready(): Promise<void> {
      ready = true
      return Promise.resolve()
    }
  }
  await expect(
    conformanceCase("listener readiness follows real bind", () => changedAddress).run()
  ).rejects.toThrow("listener readiness must retain one actual bound address")

  const wrongFailure = newFixture().handle
  const resolvesFailure = {
    ...wrongFailure,
    fail(): void {
      void wrongFailure.force(new Error("resolve instead of reject"))
    }
  }
  await expect(
    conformanceCase(
      "passive listener failure preserves Error identity",
      () => resolvesFailure
    ).run()
  ).rejects.toThrow("passive listener failure must preserve Error identity")
})

test("reports close that resolves before the owner terminal promise settles", async () => {
  if (!implementationAvailable()) return
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  const timer = setTimeout(resolveDone, 20)
  try {
    await expect(
      conformanceCase("listener close is idempotent and resolves done", () => subject).run()
    ).rejects.toThrow("Listener.close must not resolve before Listener.done settles")
  } finally {
    clearTimeout(timer)
    resolveDone()
    await done
  }
})

test("reports an empty or unstable address", async () => {
  if (!implementationAvailable()) return
  let reads = 0
  const fixture = newFixture()
  const subject: ListenerConformanceHandle = {
    ...fixture.handle,
    address(): string {
      reads += 1
      return reads === 1 ? "" : "127.0.0.1:1"
    }
  }
  await expect(
    conformanceCase("listener exposes one stable non-empty address", () => subject).run()
  ).rejects.toThrow("Listener address must be a stable non-empty string")
})

test("reports an address that changes only after listener close", async () => {
  if (!implementationAvailable()) return
  let closed = false
  const done = Promise.resolve()
  const subject: ListenerConformanceHandle = {
    address(): string {
      return closed ? "127.0.0.1:2" : "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx): Promise<void> {
      closed = true
      const failure = ctx.err()
      return failure === null ? done : Promise.reject(failure)
    }
  }

  await expect(
    conformanceCase("listener exposes one stable non-empty address", () => subject).run()
  ).rejects.toThrow("Listener address must remain stable after close")
})

test("reports an unstable done Promise", async () => {
  if (!implementationAvailable()) return
  const fixture = newFixture()
  const subject: ListenerConformanceHandle = {
    ...fixture.handle,
    done(): Promise<void> {
      return Promise.resolve()
    }
  }
  await expect(
    conformanceCase("listener exposes one stable done promise", () => subject).run()
  ).rejects.toThrow("Listener done must return the same Promise")
})

test("preserves null thrown by a malformed done implementation", async () => {
  if (!implementationAvailable()) return
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      throw null
    },
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  let observed: unknown = "not rejected"
  try {
    await conformanceCase("listener exposes one stable done promise", () => subject).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError)) throw new Error("expected listener AggregateError")
  expect(observed.errors).toEqual([null, null])
})

test("reports a close implementation that ignores a canceled caller", async () => {
  if (!implementationAvailable()) return
  const done = Promise.resolve()
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(): Promise<void> {
      return done
    }
  }
  await expect(
    conformanceCase(
      "pre-canceled and started close callers do not cancel shared listener cleanup",
      () => subject
    ).run()
  ).rejects.toThrow("a pre-canceled Listener.close caller must receive context canceled")

  const [ctx, cancel] = withCancel(background())
  cancel()
  expect(ctx.err()).toBe(canceled)
})

test("reports started close cancellation that abandons owner cleanup", async () => {
  if (!implementationAvailable()) return
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let cleanup: Promise<void> | null = null
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx): Promise<void> {
      const preexisting = ctx.err()
      if (preexisting !== null) return Promise.reject(preexisting)
      if (cleanup !== null) return cleanup
      const signal = ctx.done()
      cleanup = new Promise<void>((resolve, reject) => {
        function onAbort(): void {
          signal?.removeEventListener("abort", onAbort)
          reject(ctx.err() ?? canceled)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        setTimeout(() => {
          resolveDone()
          resolve()
        }, 25)
      })
      return cleanup
    }
  }

  let observed: unknown = null
  try {
    await conformanceCase(
      "pre-canceled and started close callers do not cancel shared listener cleanup",
      () => subject
    ).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected started close AggregateError")
  expect(observed.errors[0]).toMatchObject({
    message: "a later Listener.close caller must join owner cleanup"
  })
  resolveDone()
  await done
})

test("reports the wrong cancellation identity from a started listener close", async () => {
  if (!implementationAvailable()) return
  const wrongFailure = new Error("wrong started listener close cancellation")
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let cleanup: Promise<void> | null = null
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx): Promise<void> {
      const preexisting = ctx.err()
      if (preexisting !== null) return Promise.reject(preexisting)
      if (cleanup !== null) return cleanup
      const signal = ctx.done()
      cleanup = new Promise<void>((resolve, reject) => {
        function onAbort(): void {
          signal?.removeEventListener("abort", onAbort)
          reject(wrongFailure)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        setTimeout(() => {
          resolveDone()
          resolve()
        }, 25)
      })
      return cleanup
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase(
      "pre-canceled and started close callers do not cancel shared listener cleanup",
      () => subject
    ).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected wrong close identity AggregateError")
  expect(observed.errors[0]).toMatchObject({
    message: "a started Listener.close caller must receive context canceled"
  })
  resolveDone()
  await done
})

test("reports fulfillment after a started listener close caller is canceled", async () => {
  if (!implementationAvailable()) return
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let cleanup: Promise<void> | null = null
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx): Promise<void> {
      const preexisting = ctx.err()
      if (preexisting !== null) return Promise.reject(preexisting)
      if (cleanup === null) {
        cleanup = new Promise<void>((resolve) => {
          setTimeout(() => {
            resolveDone()
            resolve()
          }, 25)
        })
      }
      return cleanup
    }
  }

  await expect(
    conformanceCase(
      "pre-canceled and started close callers do not cancel shared listener cleanup",
      () => subject
    ).run()
  ).rejects.toThrow("a started Listener.close caller must receive context canceled")
})

test("bounds a permanently pending started listener close before cleanup", async () => {
  if (!implementationAvailable()) return
  const never = new Promise<void>(() => {})
  let closeCalls = 0
  let doneCalls = 0
  let activeCalls = 0
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      doneCalls += 1
      return done
    },
    close(ctx): Promise<void> {
      closeCalls += 1
      const preexisting = ctx.err()
      if (preexisting !== null) return Promise.reject(preexisting)
      activeCalls += 1
      if (activeCalls === 1) return never
      resolveDone()
      return Promise.resolve()
    }
  }
  const running = conformanceCase(
    "pre-canceled and started close callers do not cancel shared listener cleanup",
    () => subject
  )
    .run()
    .then(
      () => Object.freeze({ state: "resolved", failure: null }),
      (failure: unknown) => Object.freeze({ state: "rejected", failure })
    )
  let alarm: ReturnType<typeof setTimeout> | null = null
  const timed = new Promise<Readonly<{ state: "timed-out"; failure: null }>>((resolve) => {
    alarm = setTimeout(() => {
      resolve(Object.freeze({ state: "timed-out", failure: null }))
    }, 1_500)
  })
  const result = await Promise.race([running, timed])
  if (alarm !== null) clearTimeout(alarm)

  expect(result.state).toBe("rejected")
  if (result.state === "rejected") {
    expect(result.failure).toMatchObject({
      message: "started Listener.close cancellation did not settle within 1000ms"
    })
  }
  expect(closeCalls).toBe(4)
  expect(doneCalls).toBe(2)
})

test("enters bounded listener cleanup when every active close remains pending", async () => {
  if (!implementationAvailable()) return
  const never = new Promise<void>(() => {})
  const done = Promise.resolve()
  let closeCalls = 0
  let doneCalls = 0
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      doneCalls += 1
      return done
    },
    close(ctx): Promise<void> {
      closeCalls += 1
      const preexisting = ctx.err()
      return preexisting === null ? never : Promise.reject(preexisting)
    }
  }
  const running = conformanceCase(
    "pre-canceled and started close callers do not cancel shared listener cleanup",
    () => subject
  )
    .run()
    .then(
      () => Object.freeze({ state: "resolved", failure: null }),
      (failure: unknown) => Object.freeze({ state: "rejected", failure })
    )
  let alarm: ReturnType<typeof setTimeout> | null = null
  const timed = new Promise<Readonly<{ state: "timed-out"; failure: null }>>((resolve) => {
    alarm = setTimeout(() => {
      resolve(Object.freeze({ state: "timed-out", failure: null }))
    }, 2_500)
  })
  const result = await Promise.race([running, timed])
  if (alarm !== null) clearTimeout(alarm)

  expect(result.state).toBe("rejected")
  if (result.state === "rejected") {
    expect(result.failure).toBeInstanceOf(AggregateError)
    if (!(result.failure instanceof AggregateError))
      throw new Error("expected bounded cleanup AggregateError")
    expect(result.failure.errors).toEqual([
      expect.objectContaining({
        message: "started Listener.close cancellation did not settle within 1000ms"
      }),
      expect.objectContaining({ message: "listener close cleanup exceeded 1000ms" })
    ])
  }
  expect(closeCalls).toBe(4)
  expect(doneCalls).toBe(2)
})

test("observes a late started listener close rejection after its bound expires", async () => {
  if (!implementationAvailable()) return
  const lateFailure = new Error("late started listener close rejection")
  const unhandled: unknown[] = []
  let activeCalls = 0
  let lateSettled = false
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx): Promise<void> {
      const preexisting = ctx.err()
      if (preexisting !== null) return Promise.reject(preexisting)
      activeCalls += 1
      if (activeCalls === 1) {
        return new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            lateSettled = true
            reject(lateFailure)
          }, 1_100)
        })
      }
      resolveDone()
      return Promise.resolve()
    }
  }
  /** Records any rejection that escaped the conformance observer. */
  function observeUnhandled(failure: unknown): void {
    unhandled.push(failure)
  }
  process.on("unhandledRejection", observeUnhandled)
  try {
    await expect(
      conformanceCase(
        "pre-canceled and started close callers do not cancel shared listener cleanup",
        () => subject
      ).run()
    ).rejects.toThrow("started Listener.close cancellation did not settle within 1000ms")
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200)
    })
    expect(lateSettled).toBe(true)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("reports a joined listener close that resolves before done settles", async () => {
  if (!implementationAvailable()) return
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      return done
    },
    close(ctx): Promise<void> {
      const failure = ctx.err()
      return failure === null ? Promise.resolve() : Promise.reject(failure)
    }
  }
  const timer = setTimeout(resolveDone, 25)
  try {
    await expect(
      conformanceCase(
        "pre-canceled and started close callers do not cancel shared listener cleanup",
        () => subject
      ).run()
    ).rejects.toThrow("a later Listener.close must not resolve before Listener.done settles")
  } finally {
    clearTimeout(timer)
    resolveDone()
    await done
  }
})

test("observes listener close and done failures independently in declaration order", async () => {
  if (!implementationAvailable()) return
  const closeFailure = new Error("listener close failed")
  const doneFailure = new Error("listener done failed")
  let doneCalls = 0
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      doneCalls += 1
      return Promise.reject(doneFailure)
    },
    close(): Promise<void> {
      return Promise.reject(closeFailure)
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase("listener exposes one stable non-empty address", () => subject).run()
  } catch (failure) {
    observed = failure
  }
  expect(doneCalls).toBeGreaterThan(0)
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected listener cleanup AggregateError")
  expect(observed.errors).toEqual([closeFailure, doneFailure])
})

test("flattens assertion, close, and done failures in stable order", async () => {
  if (!implementationAvailable()) return
  const closeFailure = new Error("listener close failed after assertion")
  const doneFailure = new Error("listener done failed after assertion")
  const subject: ListenerConformanceHandle = {
    address(): string {
      return ""
    },
    done(): Promise<void> {
      return Promise.reject(doneFailure)
    },
    close(): Promise<void> {
      return Promise.reject(closeFailure)
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase("listener exposes one stable non-empty address", () => subject).run()
  } catch (failure) {
    observed = failure
  }
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected flattened listener AggregateError")
  expect(observed.errors).toEqual([
    expect.objectContaining({ message: "Listener address must be a stable non-empty string" }),
    closeFailure,
    doneFailure
  ])
})

test("bounds stuck listener close and done independently", async () => {
  if (!implementationAvailable()) return
  const never = new Promise<void>(() => {})
  let doneCalls = 0
  const subject: ListenerConformanceHandle = {
    address(): string {
      return "127.0.0.1:1"
    },
    done(): Promise<void> {
      doneCalls += 1
      return never
    },
    close(): Promise<void> {
      return never
    }
  }
  let observed: unknown = null
  try {
    await conformanceCase("listener exposes one stable non-empty address", () => subject).run()
  } catch (failure) {
    observed = failure
  }
  expect(doneCalls).toBeGreaterThan(0)
  expect(observed).toBeInstanceOf(AggregateError)
  if (!(observed instanceof AggregateError))
    throw new Error("expected bounded listener AggregateError")
  expect(observed.errors).toEqual([
    expect.objectContaining({ message: "listener close cleanup exceeded 1000ms" }),
    expect.objectContaining({ message: "listener done cleanup exceeded 1000ms" })
  ])
})

test("preserves an assertion failure together with listener cleanup failure", async () => {
  if (!implementationAvailable()) return
  const cleanupFailure = new Error("listener cleanup failed")
  const done = Promise.resolve()
  const subject: ListenerConformanceHandle = {
    address(): string {
      return ""
    },
    done(): Promise<void> {
      return done
    },
    close(): Promise<void> {
      return Promise.reject(cleanupFailure)
    }
  }

  let failure: unknown = null
  try {
    await conformanceCase("listener exposes one stable non-empty address", () => subject).run()
  } catch (value) {
    failure = value
  }
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("expected listener AggregateError")
  expect(failure.errors[0]).toMatchObject({
    message: "Listener address must be a stable non-empty string"
  })
  expect(failure.errors[1]).toBe(cleanupFailure)
})
