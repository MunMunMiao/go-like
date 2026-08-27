import { afterEach, expect, test } from "bun:test"
import { background, canceled, type Context, type ContextError, withCancel } from "@go-like/context"

import { circuitOpen, newCircuitBreaker } from "../src/index"
import { deferred, flush } from "./helpers"

const OriginalPerformanceNow = performance.now

afterEach(() => {
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: OriginalPerformanceNow
  })
})

/** Installs a mutable deterministic wall clock. */
function clock(initial: number): { value: number } {
  const observed = { value: initial }
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => observed.value
  })
  return observed
}

/** Creates a Context whose terminal error changes across observations. */
function racingContext(errors: readonly (ContextError | null)[]): Context {
  let reads = 0
  return Object.freeze({
    /** Reports no deadline. */
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    /** Reports no signal. */
    done(): null {
      return null
    },
    /** Returns the next configured failure observation. */
    err(): ContextError | null {
      const observed = errors[reads]
      reads += 1
      return observed ?? null
    },
    /** Reports no values. */
    value(_key: unknown): null {
      return null
    }
  })
}

test("tracks consecutive failures, resets on success, and rejects while open", async () => {
  const wall = clock(1_000)
  const first = new Error("first")
  const second = new Error("second")
  const breaker = newCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 })

  await expect(
    breaker.execute(background(), () => {
      throw first
    })
  ).rejects.toBe(first)
  expect(breaker.snapshot()).toEqual({
    state: "closed",
    consecutiveFailures: 1,
    probeActive: false,
    retryAfterMs: 0
  })
  await expect(breaker.execute(background(), () => "recovered")).resolves.toBe("recovered")
  expect(breaker.snapshot().consecutiveFailures).toBe(0)
  await expect(
    breaker.execute(background(), () => {
      throw first
    })
  ).rejects.toBe(first)
  await expect(
    breaker.execute(background(), async () => {
      throw second
    })
  ).rejects.toBe(second)

  const opened = breaker.snapshot()
  expect(opened).toEqual({
    state: "open",
    consecutiveFailures: 2,
    probeActive: false,
    retryAfterMs: 100
  })
  expect(Object.isFrozen(opened)).toBe(true)
  await expect(breaker.execute(background(), () => "blocked")).rejects.toBe(circuitOpen)

  wall.value = 1_050
  expect(breaker.snapshot().retryAfterMs).toBe(50)
})

test("admits only one half-open probe and closes after probe success", async () => {
  const wall = clock(100)
  const failure = new Error("failure")
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 })
  await expect(
    breaker.execute(background(), () => {
      throw failure
    })
  ).rejects.toBe(failure)

  wall.value = 110
  expect(breaker.snapshot()).toEqual({
    state: "half-open",
    consecutiveFailures: 1,
    probeActive: false,
    retryAfterMs: 0
  })
  const probe = deferred<string>()
  const admitted = breaker.execute(background(), () => probe.promise)
  expect(breaker.snapshot().probeActive).toBe(true)
  await expect(breaker.execute(background(), () => "second probe")).rejects.toBe(circuitOpen)

  probe.resolve("recovered")
  await expect(admitted).resolves.toBe("recovered")
  expect(breaker.snapshot()).toEqual({
    state: "closed",
    consecutiveFailures: 0,
    probeActive: false,
    retryAfterMs: 0
  })
})

test("reopens after a failed half-open probe", async () => {
  const wall = clock(1)
  const failure = new Error("failure")
  const probeFailure = new Error("probe")
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5 })
  await expect(
    breaker.execute(background(), () => {
      throw failure
    })
  ).rejects.toBe(failure)
  wall.value = 6

  await expect(
    breaker.execute(background(), () => {
      throw probeFailure
    })
  ).rejects.toBe(probeFailure)
  expect(breaker.snapshot()).toEqual({
    state: "open",
    consecutiveFailures: 1,
    probeActive: false,
    retryAfterMs: 5
  })
})

test("caller classification can record a rejected operation as a healthy breaker outcome", async () => {
  clock(10)
  const ignored = new Error("ignored")
  const counted = new Error("counted")
  const seen: unknown[] = []
  const breaker = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    isFailure: async (_ctx, failure) => {
      seen.push(failure)
      return failure === counted
    }
  })

  await expect(
    breaker.execute(background(), () => {
      throw ignored
    })
  ).rejects.toBe(ignored)
  expect(breaker.snapshot().state).toBe("closed")
  await expect(
    breaker.execute(background(), () => {
      throw counted
    })
  ).rejects.toBe(counted)
  expect(breaker.snapshot().state).toBe("open")
  expect(seen).toEqual([ignored, counted])
})

test("rejects invalid classification results and counts them as breaker failures", async () => {
  clock(0)
  const invalidOptions = {
    failureThreshold: 1,
    resetTimeoutMs: 100,
    isFailure: () => "yes"
  }
  const breaker = Reflect.apply(newCircuitBreaker, undefined, [invalidOptions])
  const failure = new Error("operation")

  await expect(
    Reflect.apply(breaker.execute, breaker, [
      background(),
      () => {
        throw failure
      }
    ])
  ).rejects.toThrow("isFailure must return a boolean")
  expect(breaker.snapshot().state).toBe("open")
})

test("counts a classifier failure as a breaker failure", async () => {
  clock(0)
  const operationFailure = new Error("operation")
  const predicateFailure = new Error("predicate")
  const breaker = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    isFailure: () => {
      throw predicateFailure
    }
  })

  await expect(
    breaker.execute(background(), () => {
      throw operationFailure
    })
  ).rejects.toBe(predicateFailure)
  expect(breaker.snapshot().state).toBe("open")
})

test("ignores late outcomes admitted by an obsolete generation", async () => {
  clock(0)
  const failure = new Error("failure")
  const successBreaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 })
  const first = deferred<string>()
  const second = deferred<string>()
  const firstCall = successBreaker.execute(background(), () => first.promise)
  const secondCall = successBreaker.execute(background(), () => second.promise)
  first.reject(failure)
  await expect(firstCall).rejects.toBe(failure)
  second.resolve("late success")
  await expect(secondCall).resolves.toBe("late success")
  expect(successBreaker.snapshot().state).toBe("open")

  const failureBreaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 })
  const third = deferred<void>()
  const fourth = deferred<void>()
  const thirdCall = failureBreaker.execute(background(), () => third.promise)
  const fourthCall = failureBreaker.execute(background(), () => fourth.promise)
  third.reject(failure)
  await expect(thirdCall).rejects.toBe(failure)
  fourth.reject(failure)
  await expect(fourthCall).rejects.toBe(failure)
  expect(failureBreaker.snapshot().consecutiveFailures).toBe(1)
})

test("Context failure is neutral and releases a half-open probe", async () => {
  const wall = clock(0)
  const failure = new Error("failure")
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1 })
  await expect(
    breaker.execute(background(), () => {
      throw failure
    })
  ).rejects.toBe(failure)
  wall.value = 1

  const ctx = racingContext([null, canceled])
  await expect(
    breaker.execute(ctx, () => {
      throw failure
    })
  ).rejects.toBe(canceled)
  expect(breaker.snapshot()).toEqual({
    state: "half-open",
    consecutiveFailures: 1,
    probeActive: false,
    retryAfterMs: 0
  })
  await expect(breaker.execute(background(), () => "next probe")).resolves.toBe("next probe")
})

test("malformed Context observation cannot retain a half-open probe", async () => {
  clock(0)
  const operationFailure = new Error("operation")
  const contextFailure = new Error("Context.err read")
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 })
  await expect(
    breaker.execute(background(), () => {
      throw operationFailure
    })
  ).rejects.toBe(operationFailure)
  expect(breaker.snapshot().state).toBe("half-open")

  let reads = 0
  const ctx: Context = Object.freeze({
    /** Reports no deadline. */
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    /** Reports no signal. */
    done(): null {
      return null
    },
    /** Starts active and then fails the post-operation Context observation. */
    err(): null {
      reads += 1
      if (reads > 1) throw contextFailure
      return null
    },
    /** Reports no values. */
    value(_key: unknown): null {
      return null
    }
  })

  await expect(
    breaker.execute(ctx, () => {
      throw operationFailure
    })
  ).rejects.toBe(contextFailure)
  expect(breaker.snapshot().probeActive).toBe(false)
})

test("Context cancellation outranks a rejecting asynchronous classifier", async () => {
  clock(0)
  const operationFailure = new Error("operation")
  const policyFailure = new Error("policy")
  const [ctx, cancel] = withCancel(background())
  let classifications = 0
  const breaker = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 0,
    isFailure: () => {
      classifications += 1
      if (classifications === 1) return true
      cancel()
      throw policyFailure
    }
  })
  await expect(
    breaker.execute(background(), () => {
      throw operationFailure
    })
  ).rejects.toBe(operationFailure)
  expect(breaker.snapshot().state).toBe("half-open")

  await expect(
    breaker.execute(ctx, () => {
      throw operationFailure
    })
  ).rejects.toBe(canceled)
  expect(breaker.snapshot().probeActive).toBe(false)
})

test("Context cancellation outranks a resolved asynchronous classifier", async () => {
  clock(0)
  const operationFailure = new Error("operation")
  const [ctx, cancel] = withCancel(background())
  let classifications = 0
  const breaker = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 0,
    isFailure: async () => {
      classifications += 1
      if (classifications === 1) return true
      await Promise.resolve()
      cancel()
      return true
    }
  })
  await expect(
    breaker.execute(background(), () => {
      throw operationFailure
    })
  ).rejects.toBe(operationFailure)
  expect(breaker.snapshot().state).toBe("half-open")

  await expect(
    breaker.execute(ctx, () => {
      throw operationFailure
    })
  ).rejects.toBe(canceled)
  expect(breaker.snapshot().probeActive).toBe(false)
})

test("pre-canceled operations are rejected before circuit admission", async () => {
  clock(0)
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1 })
  const [ctx, cancel] = withCancel(background())
  cancel()
  let calls = 0

  await expect(
    breaker.execute(ctx, () => {
      calls += 1
      return "unexpected"
    })
  ).rejects.toBe(canceled)
  expect(calls).toBe(0)
  expect(breaker.snapshot().state).toBe("closed")
})

test("validates construction, operation, Context, and monotonic-clock boundaries", async () => {
  clock(0)
  expect(() => Reflect.apply(newCircuitBreaker, undefined, [null])).toThrow(TypeError)
  for (const failureThreshold of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => newCircuitBreaker({ failureThreshold, resetTimeoutMs: 1 })).toThrow(RangeError)
  }
  for (const resetTimeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs })).toThrow(RangeError)
  }
  expect(() =>
    Reflect.apply(newCircuitBreaker, undefined, [
      {
        failureThreshold: 1,
        resetTimeoutMs: 1,
        isFailure: 1
      }
    ])
  ).toThrow(TypeError)

  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1 })
  await expect(Reflect.apply(breaker.execute, breaker, [null, () => "value"])).rejects.toThrow(
    TypeError
  )
  await expect(Reflect.apply(breaker.execute, breaker, [background(), null])).rejects.toThrow(
    "operation must be callable"
  )
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => Number.NaN
  })
  expect(() => breaker.snapshot()).toThrow(RangeError)
})

test("zero reset timeout transitions directly into half-open", async () => {
  clock(0)
  const failure = new Error("failure")
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 })
  await expect(
    breaker.execute(background(), () => {
      throw failure
    })
  ).rejects.toBe(failure)
  await flush()
  expect(breaker.snapshot().state).toBe("half-open")
})
