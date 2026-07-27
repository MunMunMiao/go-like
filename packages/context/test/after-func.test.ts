import { describe, expect, test } from "bun:test"

import {
  afterFunc,
  background,
  canceled,
  withCancel,
  type Context,
  type StopFunc
} from "../src/index"

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

/** Captures the exact synchronous failure identity from one operation. */
function captureFailure(operation: () => void): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("operation did not throw")
}

function delegateContext(delegate: (callback: () => void) => StopFunc): Context & {
  afterFunc(callback: () => void): StopFunc
} {
  const controller = new AbortController()
  const base = background()
  return {
    deadline: base.deadline,
    done: () => controller.signal,
    err: base.err,
    value: base.value,
    afterFunc: delegate
  }
}

describe("afterFunc with Context.done", () => {
  test("queues the callback in a microtask when cancellation wins", async () => {
    const [ctx, cancel] = withCancel(background())
    const calls: string[] = []
    const stop = afterFunc(ctx, () => {
      calls.push("callback")
    })

    cancel()

    expect(calls).toEqual([])
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toEqual(["callback"])
    expect(stop()).toBe(false)
  })

  test("lets stop win exactly once and suppresses later cancellation", async () => {
    const [ctx, cancel] = withCancel(background())
    let calls = 0
    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(stop()).toBe(true)
    expect(stop()).toBe(false)
    cancel()
    await flushMicrotasks()

    expect(calls).toBe(0)
  })

  test("admits an already-canceled context before stop can win", async () => {
    const [ctx, cancel] = withCancel(background())
    cancel()
    let calls = 0

    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(calls).toBe(0)
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(1)
  })

  test("returns a one-shot successful stop for a context that can never cancel", async () => {
    let calls = 0
    const stop = afterFunc(background(), () => {
      calls += 1
    })

    expect(stop()).toBe(true)
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(0)
  })

  test("admits exactly once when abort listener removal throws", async () => {
    const removalFailure = new Error("listener removal failed")
    let abortListener: EventListenerOrEventListenerObject | null = null
    let removals = 0
    let calls = 0
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        abortListener = listener
      },
      removeEventListener() {
        removals += 1
        throw removalFailure
      }
    }
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => signal as never,
      err: base.err,
      value: base.value
    }
    const stop = afterFunc(ctx, () => {
      calls += 1
    })
    const fireAbort = (): void => {
      if (abortListener === null) throw new Error("abort listener is missing")
      if (typeof abortListener === "function") abortListener(new Event("abort"))
      else abortListener.handleEvent(new Event("abort"))
    }

    expect(() => fireAbort()).not.toThrow()
    expect(calls).toBe(0)
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(1)
    expect(removals).toBe(1)

    expect(() => fireAbort()).not.toThrow()
    await flushMicrotasks()
    expect(calls).toBe(1)
    expect(removals).toBe(1)
  })
})

describe("afterFunc custom delegate", () => {
  test("uses an own callable data hook, preserves this, buffers sync admission, and runs once", async () => {
    let receiver: unknown
    let calls = 0
    const ctx = delegateContext(function (this: Context, callback): StopFunc {
      receiver = this
      callback()
      callback()
      return () => false
    })

    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(receiver).toBe(ctx)
    expect(calls).toBe(0)
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(1)
  })

  test("does not inspect a custom hook when Done is null", async () => {
    let hookCalls = 0
    let calls = 0
    const base = background()
    const ctx = {
      deadline: base.deadline,
      done: base.done,
      err: base.err,
      value: base.value,
      afterFunc(): StopFunc {
        hookCalls += 1
        return () => false
      }
    }

    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(stop()).toBe(true)
    expect(hookCalls).toBe(0)
    await flushMicrotasks()
    expect(calls).toBe(0)
  })

  test("evaluates an inherited accessor hook for an open structural signal", () => {
    let getterReads = 0
    const failure = new Error("afterFunc getter failed")
    const ctx = delegateContext(() => () => true)
    Object.defineProperty(ctx, "afterFunc", {
      configurable: true,
      get() {
        getterReads += 1
        throw failure
      }
    })

    expect(captureFailure(() => afterFunc(ctx, () => {}))).toBe(failure)
    expect(getterReads).toBe(1)
  })

  test("propagates a normal property lookup trap failure without invoking a callback", () => {
    const failure = new Error("property lookup failed")
    let calls = 0
    const proxy = new Proxy(
      delegateContext(() => () => true),
      {
        get(target, key, receiver) {
          if (key === "afterFunc") throw failure
          return Reflect.get(target, key, receiver)
        }
      }
    )

    expect(
      captureFailure(() =>
        afterFunc(proxy, () => {
          calls += 1
        })
      )
    ).toBe(failure)
    expect(calls).toBe(0)
  })

  test("discards buffered admission when the delegate throws", async () => {
    const failure = new Error("delegate failed")
    let calls = 0
    const ctx = delegateContext((callback) => {
      callback()
      throw failure
    })

    expect(
      captureFailure(() =>
        afterFunc(ctx, () => {
          calls += 1
        })
      )
    ).toBe(failure)
    await flushMicrotasks()
    expect(calls).toBe(0)
  })

  test("discards buffered admission when the delegate returns a non-function", async () => {
    let calls = 0
    const ctx = delegateContext(((callback: () => void) => {
      callback()
      return null
    }) as never)

    expect(() =>
      afterFunc(ctx, () => {
        calls += 1
      })
    ).toThrow(TypeError)
    await flushMicrotasks()
    expect(calls).toBe(0)
  })

  test("lets a successful delegated stop win and ignores a stale callback", async () => {
    let delegateCallback: (() => void) | null = null
    let calls = 0
    const ctx = delegateContext((callback) => {
      delegateCallback = callback
      return () => true
    })
    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(stop()).toBe(true)
    expect(stop()).toBe(false)
    expect(delegateCallback).not.toBeNull()
    ;(delegateCallback as unknown as () => void)()
    await flushMicrotasks()
    expect(calls).toBe(0)
  })

  test("lets synchronous admission during delegated stop beat stop", async () => {
    let delegateCallback: (() => void) | null = null
    let calls = 0
    const ctx = delegateContext((callback) => {
      delegateCallback = callback
      return () => {
        delegateCallback?.()
        return true
      }
    })
    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(1)
  })

  test("consumes a throwing delegated stop and suppresses stale admission", async () => {
    const failure = new Error("stop failed")
    const delegatedCallbacks: Array<() => void> = []
    let stopCalls = 0
    let calls = 0
    const ctx = delegateContext((callback) => {
      delegatedCallbacks.push(callback)
      return () => {
        stopCalls += 1
        throw failure
      }
    })
    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(captureFailure(stop)).toBe(failure)
    expect(stop()).toBe(false)
    expect(stopCalls).toBe(1)
    delegatedCallbacks[0]?.()
    await flushMicrotasks()
    expect(calls).toBe(0)
  })

  test("uses a class prototype hook for an open structural signal", async () => {
    const controller = new AbortController()
    let hookCalls = 0
    let calls = 0
    class PrototypeContext implements Context {
      deadline(): readonly [Date, boolean] {
        return background().deadline()
      }
      done(): AbortSignal {
        return controller.signal
      }
      err(): null {
        return null
      }
      value(): null {
        return null
      }
      afterFunc(callback: () => void): StopFunc {
        hookCalls += 1
        controller.signal.addEventListener("abort", callback, { once: true })
        return () => {
          controller.signal.removeEventListener("abort", callback)
          return true
        }
      }
    }
    const stop = afterFunc(new PrototypeContext(), () => {
      calls += 1
    })

    expect(hookCalls).toBe(1)
    controller.abort()
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(1)
  })

  test("bypasses a wrapper hook when it exposes the same local cancel signal", async () => {
    const [inner, cancel] = withCancel(background())
    let hookCalls = 0
    let calls = 0
    const wrapper = {
      deadline: () => inner.deadline(),
      done: () => inner.done(),
      err: () => inner.err(),
      value: (key: unknown) => inner.value(key),
      afterFunc(): StopFunc {
        hookCalls += 1
        return () => true
      }
    }
    const stop = afterFunc(wrapper, () => {
      calls += 1
    })

    expect(hookCalls).toBe(0)
    cancel()
    expect(stop()).toBe(false)
    await flushMicrotasks()
    expect(calls).toBe(1)
  })

  test("uses a custom parent hook for cancellation propagation and unregisters it", () => {
    const controller = new AbortController()
    let hookCalls = 0
    let stopCalls = 0
    const parent = {
      deadline: () => background().deadline(),
      done: () => controller.signal,
      err: () => null,
      value: () => null,
      afterFunc(callback: () => void): StopFunc {
        hookCalls += 1
        controller.signal.addEventListener("abort", callback, { once: true })
        return () => {
          stopCalls += 1
          controller.signal.removeEventListener("abort", callback)
          return true
        }
      }
    }
    const [child, cancelChild] = withCancel(parent)

    expect(hookCalls).toBe(1)
    cancelChild()
    expect(child.done()?.reason).toBe(child.err())
    expect(stopCalls).toBe(1)
  })
})

describe("afterFunc hook boundary", () => {
  test("ignores Object.prototype pollution without hiding an owned hook", async () => {
    const pollutablePrototype: { afterFunc?: unknown } = Object.prototype
    const previous = Object.getOwnPropertyDescriptor(pollutablePrototype, "afterFunc")
    let hookCalls = 0
    let ownedHookCalls = 0
    let callbackCalls = 0
    Object.defineProperty(pollutablePrototype, "afterFunc", {
      configurable: true,
      value(_callback: () => void): StopFunc {
        hookCalls += 1
        return () => false
      }
    })

    try {
      const rootStop = afterFunc(background(), () => {
        callbackCalls += 1
      })
      expect(rootStop()).toBe(true)

      const [ctx, cancel] = withCancel(background())
      const signalStop = afterFunc(ctx, () => {
        callbackCalls += 1
      })
      expect(signalStop()).toBe(true)
      cancel()

      const controller = new AbortController()
      const base = background()
      const external: Context = {
        deadline: base.deadline,
        done: () => controller.signal,
        err: () => (controller.signal.aborted ? canceled : null),
        value: base.value
      }
      const [structuralChild] = withCancel(external)
      controller.abort(canceled)

      const owned = delegateContext(() => {
        ownedHookCalls += 1
        return () => true
      })
      expect(afterFunc(owned, () => {})()).toBe(true)
      await flushMicrotasks()

      expect(structuralChild.err()).toBe(canceled)
      expect(hookCalls).toBe(0)
      expect(ownedHookCalls).toBe(1)
      expect(callbackCalls).toBe(0)
    } finally {
      if (previous === undefined) delete pollutablePrototype.afterFunc
      else Object.defineProperty(pollutablePrototype, "afterFunc", previous)
    }
  })
})

describe("afterFunc validation", () => {
  test("removes a done listener that fires synchronously during registration", async () => {
    let removals = 0
    let calls = 0
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") listener(new Event("abort"))
        else listener.handleEvent(new Event("abort"))
      },
      removeEventListener() {
        removals += 1
      }
    }
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => signal as never,
      err: base.err,
      value: base.value
    }

    const stop = afterFunc(ctx, () => {
      calls += 1
    })

    expect(stop()).toBe(false)
    expect(removals).toBe(1)
    await flushMicrotasks()
    expect(calls).toBe(1)
  })

  test("removes a done listener when registration throws", () => {
    const failure = new Error("registration failed")
    let removals = 0
    const signal = {
      aborted: false,
      addEventListener() {
        throw failure
      },
      removeEventListener() {
        removals += 1
      }
    }
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => signal as never,
      err: base.err,
      value: base.value
    }

    expect(captureFailure(() => afterFunc(ctx, () => {}))).toBe(failure)
    expect(removals).toBe(1)
  })

  test("removes a registered listener when the post-registration aborted read throws", () => {
    const failure = new Error("post-registration aborted read failed")
    let abortedReads = 0
    let registrations = 0
    let removals = 0
    const signal = {
      get aborted(): boolean {
        abortedReads += 1
        if (abortedReads === 3) throw failure
        return false
      },
      addEventListener() {
        registrations += 1
      },
      removeEventListener() {
        removals += 1
      }
    }
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => signal as never,
      err: base.err,
      value: base.value
    }

    expect(captureFailure(() => afterFunc(ctx, () => {}))).toBe(failure)
    expect(registrations).toBe(1)
    expect(removals).toBe(1)
  })

  test("preserves a post-registration aborted read error when listener removal also throws", () => {
    const abortedFailure = new Error("post-registration aborted read failed")
    const removalFailure = new Error("listener removal failed")
    let abortedReads = 0
    let registrations = 0
    let removals = 0
    const signal = {
      get aborted(): boolean {
        abortedReads += 1
        if (abortedReads === 3) throw abortedFailure
        return false
      },
      addEventListener() {
        registrations += 1
      },
      removeEventListener() {
        removals += 1
        throw removalFailure
      }
    }
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => signal as never,
      err: base.err,
      value: base.value
    }

    expect(captureFailure(() => afterFunc(ctx, () => {}))).toBe(abortedFailure)
    expect(registrations).toBe(1)
    expect(removals).toBe(1)
  })

  test("preserves a registration error when listener removal also throws", () => {
    const registrationFailure = new Error("registration failed")
    const removalFailure = new Error("listener removal failed")
    let removals = 0
    const signal = {
      aborted: false,
      addEventListener() {
        throw registrationFailure
      },
      removeEventListener() {
        removals += 1
        throw removalFailure
      }
    }
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => signal as never,
      err: base.err,
      value: base.value
    }

    expect(captureFailure(() => afterFunc(ctx, () => {}))).toBe(registrationFailure)
    expect(removals).toBe(1)
  })

  test("rejects invalid contexts and callbacks", () => {
    expect(() => afterFunc(null as never, () => {})).toThrow(TypeError)
    expect(() => afterFunc(background(), null as never)).toThrow(TypeError)
  })
})
