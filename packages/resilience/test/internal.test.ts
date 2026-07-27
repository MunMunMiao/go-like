import { afterEach, expect, test } from "bun:test"
import { background, canceled, type Context, type ContextError, withCancel } from "@likego/context"

import {
  activeContext,
  inspectContext,
  monotonicNow,
  readContextFailure,
  waitForDelay
} from "../src/internal"

const OriginalPerformanceNow = performance.now
const OriginalSetTimeout = globalThis.setTimeout
const OriginalClearTimeout = globalThis.clearTimeout
const OriginalErrorIsError = Object.getOwnPropertyDescriptor(Error, "isError")

/** Invokes one callback twice to prove duplicate settlement remains harmless. */
function callTwice(callback: (() => void) | null, missingMessage: string): void {
  if (callback === null) throw new Error(missingMessage)
  callback()
  callback()
}

afterEach(() => {
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: OriginalPerformanceNow
  })
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: OriginalSetTimeout
  })
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: OriginalClearTimeout
  })
  if (OriginalErrorIsError === undefined) Reflect.deleteProperty(Error, "isError")
  else Object.defineProperty(Error, "isError", OriginalErrorIsError)
})

/** Creates a structurally valid Context with controllable error observations. */
function contextWithErrors(errors: readonly (ContextError | null)[]): Context {
  let reads = 0
  return Object.freeze({
    /** Reports no deadline. */
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    /** Reports no cancellation signal. */
    done(): null {
      return null
    },
    /** Returns the next configured terminal observation. */
    err(): ContextError | null {
      const observed = errors[reads]
      reads += 1
      return observed ?? null
    },
    /** Reports no Context values. */
    value(_key: unknown): null {
      return null
    }
  })
}

test("snapshots structural Context methods and recognizes callable carriers", () => {
  const state = inspectContext(background())
  expect(state.context).toBe(background())
  expect(state.signal).toBeNull()
  expect(readContextFailure(state)).toBeNull()
  expect(activeContext(background()).context).toBe(background())

  const callable = function callableContext(): void {}
  callable.deadline = (): readonly [Date, boolean] => [new Date(0), false]
  callable.done = (): null => null
  callable.err = (): null => null
  callable.value = (_key: unknown): null => null
  expect(Reflect.apply(inspectContext, undefined, [callable]).context).toBe(callable)
})

test("rejects malformed Context and signal shapes", () => {
  for (const invalid of [null, undefined, 1, "context", {}, { err() {} }, { done() {} }]) {
    expect(() => Reflect.apply(inspectContext, undefined, [invalid])).toThrow(TypeError)
  }
  const base = background()
  for (const signal of [
    1,
    {},
    { aborted: false, addEventListener() {} },
    { aborted: false, removeEventListener() {} }
  ]) {
    const malformed = {
      deadline: base.deadline,
      done: () => signal,
      err: base.err,
      value: base.value
    }
    expect(() => Reflect.apply(inspectContext, undefined, [malformed])).toThrow(TypeError)
  }
})

test("normalizes an aborted signal race and preserves explicit Context failure", () => {
  const explicit = contextWithErrors([canceled])
  expect(readContextFailure(inspectContext(explicit))).toBe(canceled)

  const base = background()
  const aborted = {
    aborted: true,
    addEventListener() {},
    removeEventListener() {}
  }
  const raced = {
    deadline: base.deadline,
    done: () => aborted,
    err: base.err,
    value: base.value
  }
  expect(readContextFailure(Reflect.apply(inspectContext, undefined, [raced]))).toBe(canceled)
  expect(() => Reflect.apply(activeContext, undefined, [raced])).toThrow(canceled)
})

test("validates Context.err and supports the standard Error fallback", () => {
  Object.defineProperty(Error, "isError", {
    configurable: true,
    writable: true,
    value: undefined
  })
  const fallbackFailure = new Error("fallback")
  expect(readContextFailure(inspectContext(contextWithErrors([fallbackFailure])))).toBe(
    fallbackFailure
  )

  const base = background()
  const malformed = {
    deadline: base.deadline,
    done: base.done,
    err: () => "not an Error",
    value: base.value
  }
  expect(() => readContextFailure(Reflect.apply(inspectContext, undefined, [malformed]))).toThrow(
    TypeError
  )

  Object.defineProperty(Error, "isError", {
    configurable: true,
    writable: true,
    value: () => false
  })
  expect(() => readContextFailure(inspectContext(contextWithErrors([fallbackFailure])))).toThrow(
    TypeError
  )
})

test("validates the monotonic clock and returns finite observations", () => {
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => 456
  })
  expect(monotonicNow()).toBe(456)
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => Number.NaN
  })
  expect(() => monotonicNow()).toThrow(RangeError)
})

test("completes zero and timer-backed delays", async () => {
  await expect(waitForDelay(background(), 0)).resolves.toBeUndefined()
  await expect(waitForDelay(background(), 1)).resolves.toBeUndefined()

  let callback: (() => void) | null = null
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (scheduled: () => void): number => {
      callback = scheduled
      return 1
    }
  })
  const delayed = waitForDelay(background(), 10)
  callTwice(callback, "timer callback was not installed")
  await expect(delayed).resolves.toBeUndefined()
})

test("Context cancellation clears delay ownership and preserves cancellation", async () => {
  const [ctx, cancel] = withCancel(background())
  const delayed = waitForDelay(ctx, 10_000)
  cancel()

  await expect(delayed).rejects.toBe(canceled)
})

test("closes registration races and tolerates listener cleanup failure", async () => {
  let abortedReads = 0
  let removals = 0
  const signal = {
    get aborted(): boolean {
      abortedReads += 1
      return abortedReads >= 3
    },
    addEventListener() {},
    removeEventListener() {
      removals += 1
      throw new Error("remove")
    }
  }
  const base = background()
  const raced = {
    deadline: base.deadline,
    done: () => signal,
    err: base.err,
    value: base.value
  }

  await expect(Reflect.apply(waitForDelay, undefined, [raced, 10_000])).rejects.toBe(canceled)
  expect(removals).toBe(1)
})

test("handles synchronous abort registration and synchronous timer settlement", async () => {
  const base = background()
  let timerCalls = 0
  const synchronousAbortSignal = {
    aborted: false,
    addEventListener(_type: string, listener: () => void) {
      listener()
    },
    removeEventListener() {}
  }
  const synchronousAbortContext = {
    deadline: base.deadline,
    done: () => synchronousAbortSignal,
    err: base.err,
    value: base.value
  }
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (): number => {
      timerCalls += 1
      return 1
    }
  })
  await expect(Reflect.apply(waitForDelay, undefined, [synchronousAbortContext, 10])).rejects.toBe(
    canceled
  )
  expect(timerCalls).toBe(0)

  let clearCalls = 0
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (callback: () => void): number => {
      callback()
      return 2
    }
  })
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: (): never => {
      clearCalls += 1
      throw new Error("clear")
    }
  })
  await expect(waitForDelay(background(), 10)).resolves.toBeUndefined()
  expect(clearCalls).toBe(1)
})

test("preserves setup and cancellation-observation failures", async () => {
  const setupFailure = new Error("listener setup")
  let removals = 0
  const base = background()
  const setupSignal = {
    aborted: false,
    addEventListener() {
      throw setupFailure
    },
    removeEventListener() {
      removals += 1
    }
  }
  const setupContext = {
    deadline: base.deadline,
    done: () => setupSignal,
    err: base.err,
    value: base.value
  }
  await expect(Reflect.apply(waitForDelay, undefined, [setupContext, 10])).rejects.toBe(
    setupFailure
  )
  expect(removals).toBe(1)

  const timerFailure = new Error("timer setup")
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (): never => {
      throw timerFailure
    }
  })
  await expect(waitForDelay(background(), 10)).rejects.toBe(timerFailure)
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: OriginalSetTimeout
  })

  let listener: (() => void) | null = null
  let errorReads = 0
  const observationFailure = new Error("err observation")
  const observationSignal = {
    aborted: false,
    addEventListener(_type: string, installed: () => void) {
      listener = installed
    },
    removeEventListener() {}
  }
  const observationContext = {
    deadline: base.deadline,
    done: () => observationSignal,
    err() {
      errorReads += 1
      if (errorReads > 1) throw observationFailure
      return null
    },
    value: base.value
  }
  const delayed = Reflect.apply(waitForDelay, undefined, [observationContext, 10_000])
  callTwice(listener, "abort listener was not installed")
  await expect(delayed).rejects.toBe(observationFailure)
})
