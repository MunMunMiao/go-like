import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import {
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancel,
  withCancelCause,
  withDeadline,
  withoutCancel,
  withValue,
  type Context
} from "../src/index"
import { newCancelContext } from "../src/cancel"
import { inspectContext } from "../src/internal"

describe("context sentinels", () => {
  test("exposes stable cancellation and deadline sentinel behavior", () => {
    expect(canceled).toBeInstanceOf(Error)
    expect(deadlineExceeded).toBeInstanceOf(Error)
    expect(deadlineExceeded.timeout()).toBe(true)
    expect(deadlineExceeded.temporary()).toBe(true)
    expect(canceled).not.toBe(deadlineExceeded)
  })
})

describe("cancellation", () => {
  test("exposes only the four Context methods on cancelable and deadline contexts", () => {
    const cancelable = withCancel(background())
    const deadline = withDeadline(background(), new Date(Date.now() + 60_000))

    for (const [ctx, cancel] of [cancelable, deadline]) {
      expect(Object.keys(ctx).sort()).toEqual(["deadline", "done", "err", "value"])
      expect(Object.getOwnPropertyNames(ctx).sort()).toEqual(["deadline", "done", "err", "value"])
      expect((ctx as Context & { cancel?: unknown }).cancel).toBeUndefined()
      expect((ctx as Context & { addCleanup?: unknown }).addCleanup).toBeUndefined()
      cancel()
    }
  })

  test("cancels a child without canceling its parent and keeps done stable", () => {
    const [parent, cancelParent] = withCancel(background())
    const [child, cancelChild] = withCancel(parent)
    const signal = child.done()

    cancelChild()
    cancelChild()

    expect(child.done()).toBe(signal)
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe(canceled)
    expect(child.err()).toBe(canceled)
    expect(cause(child)).toBe(canceled)
    expect(parent.err()).toBeNull()
    expect(parent.done()?.aborted).toBe(false)
    cancelParent()
  })

  test("propagates the first parent cause to descendants", () => {
    const [parent, cancelParent] = withCancelCause(background())
    const [child] = withCancel(parent)
    const first = new Error("first")

    cancelParent(first)
    cancelParent(new Error("second"))

    expect(parent.err()).toBe(canceled)
    expect(child.err()).toBe(canceled)
    expect(cause(parent)).toBe(first)
    expect(cause(child)).toBe(first)
  })

  test("synchronously inherits parent cancellation when constructed inside its abort listener", () => {
    const [parent, cancelParent] = withCancelCause(background())
    const parentCause = new Error("parent re-entry")
    const observations: Array<{
      readonly aborted: boolean | undefined
      readonly err: Error | null
      readonly cause: Error | null
    }> = []

    parent.done()?.addEventListener(
      "abort",
      () => {
        const [child] = withCancel(parent)
        observations.push({
          aborted: child.done()?.aborted,
          err: child.err(),
          cause: cause(child)
        })
      },
      { once: true }
    )

    cancelParent(parentCause)

    expect(observations).toEqual([
      {
        aborted: true,
        err: canceled,
        cause: parentCause
      }
    ])
  })

  test("finishes an independently nested cancellation wave before its CancelFunc returns", () => {
    const [outer, cancelOuter] = withCancel(background())
    const [nested, cancelNested] = withCancel(background())
    const [nestedChild] = withCancel(nested)
    const observationsAtReturn: Array<Error | null> = []

    outer.done()?.addEventListener(
      "abort",
      () => {
        cancelNested()
        observationsAtReturn.push(nestedChild.err())
      },
      { once: true }
    )

    cancelOuter()

    expect(observationsAtReturn).toEqual([canceled])
    expect(nestedChild.err()).toBe(canceled)
  })

  test("runs parent propagation cleanup only after every descendant is terminal", () => {
    const signal = new AbortController().signal
    let child: Context | null = null
    const observationsDuringCleanup: Array<Error | null> = []
    const external: Context & { afterFunc(callback: () => void): () => boolean } = {
      deadline: background().deadline,
      done: () => signal,
      err: () => null,
      value: () => null,
      afterFunc() {
        return () => {
          observationsDuringCleanup.push(child?.err() ?? null)
          return true
        }
      }
    }
    const [parent, cancelParent] = withCancel(external)
    ;[child] = withCancel(parent)

    cancelParent()

    expect(observationsDuringCleanup).toEqual([canceled])
    expect(child.err()).toBe(canceled)
  })

  test("normalizes a null cancel cause to canceled", () => {
    const [ctx, cancel] = withCancelCause(background())

    cancel(null)

    expect(ctx.err()).toBe(canceled)
    expect(cause(ctx)).toBe(canceled)
  })

  test("rejects a non-Error cancel cause without consuming cancellation", () => {
    const [ctx, cancel] = withCancelCause(background())

    expect(() => Reflect.apply(cancel, undefined, ["invalid cause"])).toThrow(TypeError)
    expect(ctx.err()).toBeNull()
    expect(ctx.done()?.aborted).toBe(false)

    const validCause = new Error("valid cause")
    cancel(validCause)
    expect(ctx.err()).toBe(canceled)
    expect(cause(ctx)).toBe(validCause)
  })

  test("preserves cross-realm Error cause identity", () => {
    const foreignCause = runInNewContext("new Error('foreign cause')") as Error
    const [ctx, cancel] = withCancelCause(background())

    expect(foreignCause).not.toBeInstanceOf(Error)
    cancel(foreignCause)

    expect(cause(ctx)).toBe(foreignCause)
  })

  test("retains parent values through a cancel context", () => {
    const parent = withValue(background(), "key", "value")
    const [ctx, cancel] = withCancel(parent)

    expect(ctx.value("key")).toBe("value")
    cancel()
  })

  test("creates an already-canceled child from an already-canceled parent", () => {
    const [parent, cancel] = withCancelCause(background())
    const cancellationCause = new Error("parent stopped")
    cancel(cancellationCause)

    const [child] = withCancel(parent)

    expect(child.done()?.aborted).toBe(true)
    expect(child.err()).toBe(canceled)
    expect(cause(child)).toBe(cancellationCause)
  })

  test("settles public cancellation once when parent listener removal throws", () => {
    const removalFailure = new Error("listener removal failed")
    let removals = 0
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        removals += 1
        throw removalFailure
      }
    }
    const parent: Context = {
      deadline: () => [new Date(0), false],
      done: () => signal as never,
      err: () => null,
      value: () => null
    }
    const [ctx, cancel] = withCancelCause(parent)
    const firstCause = new Error("first")

    expect(() => cancel(firstCause)).not.toThrow()
    expect(ctx.err()).toBe(canceled)
    expect(cause(ctx)).toBe(firstCause)
    expect(ctx.done()?.aborted).toBe(true)
    expect(removals).toBe(1)

    expect(() => cancel(new Error("second"))).not.toThrow()
    expect(cause(ctx)).toBe(firstCause)
    expect(removals).toBe(1)
  })

  test("runs every cleanup and aborts once when one cleanup throws", () => {
    const handle = newCancelContext(inspectContext(background()), null, null)
    const cleanupFailure = new Error("cleanup failed")
    const cancellationCause = new Error("canceled")
    const events: string[] = []
    const signal = handle.context.done()
    if (signal === null) throw new Error("cancel context must expose a signal")
    signal.addEventListener("abort", () => {
      events.push("abort")
    })
    handle.addCleanup(() => {
      events.push("first-cleanup")
      throw cleanupFailure
    })
    handle.addCleanup(() => {
      events.push("second-cleanup")
    })
    let firstResult = false

    expect(() => {
      firstResult = handle.cancel(canceled, cancellationCause)
    }).not.toThrow()
    expect(firstResult).toBe(true)
    expect(events).toEqual(["abort", "first-cleanup", "second-cleanup"])
    expect(handle.context.err()).toBe(canceled)
    expect(cause(handle.context)).toBe(cancellationCause)

    expect(handle.cancel(canceled, new Error("second"))).toBe(false)
    expect(events).toEqual(["abort", "first-cleanup", "second-cleanup"])
    expect(cause(handle.context)).toBe(cancellationCause)
  })
})

describe("values and cancellation detachment", () => {
  test("looks up the nearest value by JavaScript key identity", () => {
    const key = {}
    const other = {}
    const parent = withValue(background(), key, "parent")
    const child = withValue(parent, key, "child")

    expect(child.value(key)).toBe("child")
    expect(child.value(other)).toBeNull()
  })

  test("value contexts retain parent cancellation and cause", () => {
    const [parent, cancel] = withCancelCause(background())
    const ctx = withValue(parent, "key", "value")
    const cancellationCause = new Error("closed")

    cancel(cancellationCause)

    expect(ctx.done()).toBe(parent.done())
    expect(ctx.err()).toBe(canceled)
    expect(cause(ctx)).toBe(cancellationCause)
  })

  test("preserves cause through structural value delegation and descendants", () => {
    const [inner, cancel] = withCancelCause(background())
    const wrapper: Context = {
      deadline: () => inner.deadline(),
      done: () => inner.done(),
      err: () => inner.err(),
      value: (key) => inner.value(key)
    }
    const [descendant] = withCancel(wrapper)
    const cancellationCause = new Error("wrapped cancellation")

    cancel(cancellationCause)

    expect(cause(wrapper)).toBe(cancellationCause)
    expect(cause(descendant)).toBe(cancellationCause)
    expect(cause(withoutCancel(wrapper))).toBeNull()
  })

  test("requires the outer structural Err before consulting a delegated cause", () => {
    const [inner, cancel] = withCancelCause(background())
    const cancellationCause = new Error("hidden cancellation")
    let valueReads = 0
    const wrapper: Context = {
      deadline: () => inner.deadline(),
      done: () => null,
      err: () => null,
      value(key) {
        valueReads += 1
        return inner.value(key)
      }
    }
    cancel(cancellationCause)

    expect(cause(wrapper)).toBeNull()
    expect(valueReads).toBe(0)
  })

  test("delegates parent deadlines lazily from cancel and value contexts", () => {
    let deadlineCalls = 0
    let deadlineEpoch = 1_000
    const parent: Context = {
      deadline() {
        deadlineCalls += 1
        return [new Date(deadlineEpoch), true]
      },
      done: () => null,
      err: () => null,
      value: () => null
    }

    const [cancelContext, cancel] = withCancel(parent)
    const valueContext = withValue(parent, "key", "value")
    expect(deadlineCalls).toBe(0)

    deadlineEpoch = 2_000
    expect(cancelContext.deadline()[0].getTime()).toBe(2_000)
    deadlineEpoch = 3_000
    expect(valueContext.deadline()[0].getTime()).toBe(3_000)
    expect(deadlineCalls).toBe(2)
    cancel()
  })

  test("resolves deep built-in value chains iteratively across every Context method", () => {
    const retainedKey = {}
    let ctx = withValue(background(), retainedKey, "retained")
    for (let index = 0; index < 20_000; index += 1) ctx = withValue(ctx, {}, index)

    expect(ctx.deadline()[1]).toBe(false)
    expect(ctx.done()).toBeNull()
    expect(ctx.err()).toBeNull()
    expect(ctx.value(retainedKey)).toBe("retained")
    expect(ctx.value({})).toBeNull()
    expect(cause(ctx)).toBeNull()

    const [child, cancel] = withCancel(ctx)
    expect(child.deadline()[1]).toBe(false)
    expect(child.err()).toBeNull()
    cancel()
  })

  test("propagates cancellation iteratively through a deep built-in cancel chain", () => {
    const [root, cancelRoot] = withCancelCause(background())
    const cancellationCause = new Error("deep cancellation")
    let tail = root
    for (let index = 0; index < 20_000; index += 1) {
      const [child] = withCancel(tail)
      tail = child
    }

    expect(() => cancelRoot(cancellationCause)).not.toThrow()
    expect(tail.done()?.aborted).toBe(true)
    expect(tail.err()).toBe(canceled)
    expect(cause(tail)).toBe(cancellationCause)
  }, 30_000)

  test("rejects nullish value keys after validating the parent", () => {
    expect(() => withValue(background(), null, "value")).toThrow(TypeError)
    expect(() => withValue(background(), undefined, "value")).toThrow(TypeError)
    expect(() => withValue(null as never, null, "value")).toThrow("parent must be a Context")
  })

  test("withoutCancel retains values while removing cancellation and deadlines", () => {
    const [parent, cancel] = withCancelCause(background())
    const valued = withValue(parent, "key", "value")
    const detached = withoutCancel(valued)
    cancel(new Error("ignored"))

    expect(detached.value("key")).toBe("value")
    expect(detached.done()).toBeNull()
    expect(detached.err()).toBeNull()
    expect(detached.deadline()[1]).toBe(false)
    expect(cause(detached)).toBeNull()
  })
})

describe("parent validation", () => {
  test.each([null, undefined, {}, { deadline() {}, done() {}, err() {} }])(
    "rejects an invalid structural parent before construction",
    (parent) => {
      expect(() => withCancel(parent as never)).toThrow(TypeError)
      expect(() => withValue(parent as never, "key", "value")).toThrow(TypeError)
      expect(() => withoutCancel(parent as never)).toThrow(TypeError)
    }
  )

  test("does not eagerly inspect an inherited deadline but validates done signals", () => {
    const base = background()
    const invalidTuple = {
      deadline: () => ({}) as never,
      done: base.done,
      err: base.err,
      value: base.value
    }
    const invalidDate = {
      deadline: () => [{}, true] as never,
      done: base.done,
      err: base.err,
      value: base.value
    }
    const invalidSignal = {
      deadline: base.deadline,
      done: () => ({ aborted: false, addEventListener() {} }) as never,
      err: base.err,
      value: base.value
    }

    const [tupleChild, cancelTuple] = withCancel(invalidTuple as never)
    const [dateChild, cancelDate] = withCancel(invalidDate as never)
    expect(tupleChild.deadline() as unknown).toEqual({})
    expect(dateChild.deadline() as unknown).toEqual([{}, true])
    cancelTuple()
    cancelDate()
    expect(() => withCancel(invalidSignal)).toThrow(TypeError)
  })

  test("settles Done before parent cleanup can re-enter Err", () => {
    const controller = new AbortController()
    let child: Context | null = null
    let observedAtomicState = false
    const parent: Context & { afterFunc(callback: () => void): () => boolean } = {
      deadline: () => [new Date(0), false],
      done: () => controller.signal,
      err: () => null,
      value: () => null,
      afterFunc() {
        return () => {
          observedAtomicState = child?.err() === canceled && child.done()?.aborted === true
          return true
        }
      }
    }
    const derived = withCancel(parent)
    child = derived[0]

    derived[1]()

    expect(observedAtomicState).toBe(true)
  })

  test("closes cancellation that races listener registration", () => {
    let abortedReads = 0
    let removals = 0
    const signal = new EventTarget() as EventTarget & { readonly aborted: boolean }
    Object.defineProperty(signal, "aborted", {
      get() {
        abortedReads += 1
        return abortedReads >= 3
      }
    })
    const originalRemove = signal.removeEventListener
    signal.removeEventListener = function (...args): void {
      removals += 1
      const [type, listener, options] = args
      if (listener !== null) originalRemove.call(this, type, listener, options)
    }
    const parent: Context = {
      deadline: () => [new Date(0), false],
      done: () => signal as never,
      err: () => canceled,
      value: () => null
    }

    const [ctx] = withCancel(parent)

    expect(ctx.err()).toBe(canceled)
    expect(ctx.done()?.aborted).toBe(true)
    expect(removals).toBe(1)
  })

  test("cleans a parent listener that fires synchronously during registration", () => {
    let removals = 0
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
    const parent: Context = {
      deadline: () => [new Date(0), false],
      done: () => signal as never,
      err: () => canceled,
      value: () => null
    }

    const [ctx] = withCancel(parent)

    expect(ctx.err()).toBe(canceled)
    expect(removals).toBe(1)
  })

  test("removes a parent listener when registration throws", () => {
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
    const parent: Context = {
      deadline: () => [new Date(0), false],
      done: () => signal as never,
      err: () => null,
      value: () => null
    }

    expect(() => withCancel(parent)).toThrow(failure)
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
    const parent: Context = {
      deadline: () => [new Date(0), false],
      done: () => signal as never,
      err: () => null,
      value: () => null
    }

    expect(() => withCancel(parent)).toThrow(registrationFailure)
    expect(removals).toBe(1)
  })

  test("returns err as cause for an external structural Context", () => {
    const externalCause = new Error("external")
    const ctx: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err: () => externalCause,
      value: () => null
    }

    expect(cause(ctx)).toBe(externalCause)
  })

  test("rejects non-Error err results from an external structural Context", () => {
    const controller = new AbortController()
    const base = background()
    const ctx: Context = {
      deadline: base.deadline,
      done: () => controller.signal,
      err: base.err,
      value: base.value
    }
    Object.defineProperty(ctx, "err", {
      configurable: true,
      value: () => "invalid error"
    })

    expect(() => cause(ctx)).toThrow(TypeError)
    controller.abort(canceled)
    expect(() => withCancel(ctx)).toThrow(TypeError)
  })
})
