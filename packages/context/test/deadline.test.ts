import { afterEach, describe, expect, test } from "bun:test"

import {
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancel,
  withCancelCause,
  withDeadline,
  withDeadlineCause,
  withTimeout,
  withTimeoutCause,
  type Context
} from "../src/index"

const MaximumTimerDelay = 2_147_483_647
const MaximumTimeClip = 8_640_000_000_000_000

const originalDateNow = Date.now
const originalPerformanceNow = performance.now
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

afterEach(() => {
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow })
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: originalPerformanceNow
  })
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: originalSetTimeout
  })
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: originalClearTimeout
  })
})

function setClock(wall: () => number, monotonic: () => number): void {
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: wall })
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: monotonic
  })
}

interface TimerHarness {
  readonly delays: number[]
  readonly cleared: number[]
  fire(index: number): void
}

function installTimers(events?: string[]): TimerHarness {
  const delays: number[] = []
  const cleared: number[] = []
  const callbacks: Array<() => void> = []
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: ((callback: () => void, delay?: number) => {
      events?.push("timer")
      delays.push(delay ?? 0)
      callbacks.push(callback)
      return callbacks.length
    }) as typeof setTimeout
  })
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: ((id: number) => {
      cleared.push(id)
    }) as typeof clearTimeout
  })
  return {
    delays,
    cleared,
    fire(index) {
      const callback = callbacks[index]
      if (callback === undefined) throw new Error(`missing timer ${index}`)
      callback()
    }
  }
}

function structuralParent(deadline: Date | null, events: string[] = []): Context {
  return {
    deadline() {
      events.push("parent-deadline")
      return deadline === null ? [new Date(0), false] : [deadline, true]
    },
    done: () => null,
    err: () => null,
    value: () => null
  }
}

describe("deadline snapshots", () => {
  test("synchronously inherits re-entrant parent cancellation without arming a timer", () => {
    setClock(
      () => 1_000,
      () => 10
    )
    const timers = installTimers()
    const [parent, cancelParent] = withCancelCause(background())
    const parentCause = new Error("re-entrant parent")
    const observations: Array<readonly [Error | null, Error | null, boolean | undefined]> = []

    parent.done()?.addEventListener(
      "abort",
      () => {
        const [deadlineChild] = withDeadline(parent, new Date(2_000))
        const [timeoutChild] = withTimeout(parent, 1_000)
        observations.push(
          [deadlineChild.err(), cause(deadlineChild), deadlineChild.done()?.aborted],
          [timeoutChild.err(), cause(timeoutChild), timeoutChild.done()?.aborted]
        )
      },
      { once: true }
    )

    cancelParent(parentCause)

    expect(observations).toEqual([
      [canceled, parentCause, true],
      [canceled, parentCause, true]
    ])
    expect(timers.delays).toEqual([])
  })

  test("samples requested, parent, wall, and monotonic clocks exactly once in order", () => {
    const events: string[] = []
    const requested = new Date(1_200)
    const parentDate = new Date(1_500)
    const parent = structuralParent(parentDate, events)
    const originalGetTime = Date.prototype.getTime
    Object.defineProperty(Date.prototype, "getTime", {
      configurable: true,
      writable: true,
      value: function (this: Date): number {
        events.push(this === requested ? "requested-get-time" : "parent-get-time")
        return originalGetTime.call(this)
      }
    })
    setClock(
      () => {
        events.push("wall")
        return 1_000
      },
      () => {
        events.push("monotonic")
        return 25
      }
    )
    installTimers(events)

    try {
      const [ctx, cancel] = withDeadline(parent, requested)
      requested.setTime(9_000)
      parentDate.setTime(8_000)

      expect(events).toEqual([
        "requested-get-time",
        "parent-deadline",
        "parent-get-time",
        "wall",
        "monotonic",
        "timer"
      ])
      const first = ctx.deadline()
      const second = ctx.deadline()
      expect(first[0].getTime()).toBe(1_200)
      expect(second[0].getTime()).toBe(1_200)
      expect(first[0]).not.toBe(second[0])
      cancel()
    } finally {
      Object.defineProperty(Date.prototype, "getTime", {
        configurable: true,
        writable: true,
        value: originalGetTime
      })
    }
  })

  test("uses the earlier parent deadline snapshot", () => {
    setClock(
      () => 1_000,
      () => 10
    )
    installTimers()
    const [ctx, cancel] = withDeadline(structuralParent(new Date(1_100)), new Date(1_500))

    expect(ctx.deadline()[0].getTime()).toBe(1_100)
    cancel()
  })

  test("inherits an earlier parent deadline timer and cause without arming a child timer", () => {
    let monotonicReads = 0
    const monotonic = [10, 110]
    setClock(
      () => 1_000,
      () => {
        monotonicReads += 1
        return monotonic.shift() ?? 110
      }
    )
    const timers = installTimers()
    const parentCause = new Error("parent deadline")
    const [parent] = withDeadlineCause(background(), new Date(1_100), parentCause)
    const [child] = withDeadline(parent, new Date(1_500))

    expect(child.deadline()[0].getTime()).toBe(1_100)
    expect(timers.delays).toEqual([100])
    expect(monotonicReads).toBe(1)

    timers.fire(0)

    expect(child.err()).toBe(deadlineExceeded)
    expect(cause(child)).toBe(parentCause)
  })

  test("uses Go's WithCancel fast path for an earlier parent deadline without Done", () => {
    let monotonicReads = 0
    const monotonic = [10, 110]
    setClock(
      () => 1_000,
      () => {
        monotonicReads += 1
        return monotonic.shift() ?? 110
      }
    )
    const timers = installTimers()
    const parent = structuralParent(new Date(1_100))
    const [child] = withDeadline(parent, new Date(1_500))

    expect(child.deadline()[0].getTime()).toBe(1_100)
    expect(timers.delays).toEqual([])
    expect(monotonicReads).toBe(0)
    expect(child.err()).toBeNull()
    expect(cause(child)).toBeNull()
  })

  test("rejects invalid dates and wall samples without allocating timers", () => {
    const timers = installTimers()
    const parent = structuralParent(null)
    const malformedParent: Context = {
      deadline: () => ({}) as never,
      done: () => null,
      err: () => null,
      value: () => null
    }
    const nonDateParent: Context = {
      deadline: () => [{}, true] as never,
      done: () => null,
      err: () => null,
      value: () => null
    }

    expect(() => withDeadline(parent, {} as Date)).toThrow(TypeError)
    expect(() => withDeadline(parent, new Date(Number.NaN))).toThrow(RangeError)
    expect(() => withDeadline(malformedParent, new Date(1_000))).toThrow(TypeError)
    expect(() => withDeadline(nonDateParent, new Date(1_000))).toThrow(TypeError)
    setClock(
      () => Number.NaN,
      () => 0
    )
    expect(() => withDeadline(parent, new Date(1_000))).toThrow(RangeError)
    setClock(
      () => MaximumTimeClip + 1,
      () => 0
    )
    expect(() => withDeadline(parent, new Date(1_000))).toThrow(RangeError)
    expect(timers.delays).toEqual([])
  })

  test("rejects non-Error deadline causes before reading clocks or allocating timers", () => {
    const events: string[] = []
    const parent = structuralParent(null, events)
    setClock(
      () => {
        events.push("wall")
        return 1_000
      },
      () => {
        events.push("monotonic")
        return 0
      }
    )
    const timers = installTimers(events)

    expect(() =>
      Reflect.apply(withDeadlineCause, undefined, [parent, new Date(2_000), "invalid cause"])
    ).toThrow(TypeError)
    expect(() =>
      Reflect.apply(withTimeoutCause, undefined, [parent, 1_000, "invalid cause"])
    ).toThrow(TypeError)
    expect(events).toEqual([])
    expect(timers.delays).toEqual([])
  })

  test("expires past deadlines synchronously without reading monotonic time or arming", () => {
    let monotonicReads = 0
    setClock(
      () => 1_000,
      () => {
        monotonicReads += 1
        return 0
      }
    )
    const timers = installTimers()
    const deadlineCause = new Error("deadline cause")

    const [ctx] = withDeadlineCause(background(), new Date(1_000), deadlineCause)

    expect(ctx.err()).toBe(deadlineExceeded)
    expect(ctx.done()?.aborted).toBe(true)
    expect(ctx.done()?.reason).toBe(deadlineExceeded)
    expect(cause(ctx)).toBe(deadlineCause)
    expect(monotonicReads).toBe(0)
    expect(timers.delays).toEqual([])
  })
})

describe("timeout validation", () => {
  test("validates a finite timeout before reading the parent deadline or wall clock", () => {
    const events: string[] = []
    const parent = structuralParent(null, events)
    setClock(
      () => {
        events.push("wall")
        return 1_000
      },
      () => 0
    )

    expect(() => withTimeout(parent, Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(events).toEqual([])
  })

  test("rejects non-finite and out-of-TimeClip requested epochs", () => {
    const timers = installTimers()
    setClock(
      () => MaximumTimeClip,
      () => 0
    )

    expect(() => withTimeout(background(), 1)).toThrow(RangeError)
    expect(timers.delays).toEqual([])
  })

  test("truncates the requested timeout epoch and returns fresh Date objects", () => {
    setClock(
      () => 1_000.75,
      () => 5
    )
    installTimers()
    const [ctx, cancel] = withTimeout(background(), 0.8)

    const first = ctx.deadline()
    const second = ctx.deadline()
    expect(first[0].getTime()).toBe(1_001)
    expect(first[0]).not.toBe(second[0])
    cancel()
  })

  test("samples timeout origin before parent Deadline and expires parent lookup time", () => {
    const events: string[] = []
    const walls = [1_000, 1_100]
    const parent = structuralParent(null, events)
    setClock(
      () => {
        events.push("wall")
        return walls.shift() ?? 1_100
      },
      () => {
        events.push("monotonic")
        return 0
      }
    )
    const timers = installTimers(events)

    const [ctx] = withTimeout(parent, 50)

    expect(events).toEqual(["wall", "parent-deadline", "wall"])
    expect(ctx.err()).toBe(deadlineExceeded)
    expect(timers.delays).toEqual([])
  })
})

describe("monotonic timers and cleanup", () => {
  test("clears descendant timers before ancestor timers", () => {
    setClock(
      () => 1_000,
      () => 10
    )
    const timers = installTimers()
    const [parent, cancelParent] = withTimeout(background(), 2_000)
    const [child] = withTimeout(parent, 1_000)

    cancelParent()

    expect(parent.err()).toBe(canceled)
    expect(child.err()).toBe(canceled)
    expect(timers.cleared).toEqual([2, 1])
  })

  test("preserves cleanup registration order within one timed context", () => {
    setClock(
      () => 1_000,
      () => 10
    )
    const events: string[] = []
    const controller = new AbortController()
    const external: Context & { afterFunc(callback: () => void): () => boolean } = {
      deadline: background().deadline,
      done: () => controller.signal,
      err: () => null,
      value: () => null,
      afterFunc() {
        return () => {
          events.push("stop-parent")
          return true
        }
      }
    }
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: (() => 1) as unknown as typeof setTimeout
    })
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: (() => {
        events.push("clear-timer")
      }) as typeof clearTimeout
    })
    const [context, cancel] = withTimeout(external, 1_000)

    cancel()

    expect(context.err()).toBe(canceled)
    expect(events).toEqual(["stop-parent", "clear-timer"])
  })

  test("clears an owned timer only after descendants observe cancellation", () => {
    setClock(
      () => 1_000,
      () => 10
    )
    let child: Context | null = null
    const observationsDuringClear: Array<Error | null> = []
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: (() => 1) as unknown as typeof setTimeout
    })
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: (() => {
        observationsDuringClear.push(child?.err() ?? null)
      }) as typeof clearTimeout
    })
    const [parent, cancelParent] = withTimeout(background(), 1_000)
    ;[child] = withCancel(parent)

    cancelParent()

    expect(observationsDuringClear).toEqual([canceled])
    expect(child.err()).toBe(canceled)
  })

  test("rejects invalid initial monotonic samples and cleans construction state", () => {
    setClock(
      () => 1_000,
      () => Number.NaN
    )
    const timers = installTimers()

    expect(() => withDeadline(background(), new Date(2_000))).toThrow(RangeError)
    expect(timers.delays).toEqual([])
  })

  test("does not arm a timer when monotonic sampling re-enters parent cancellation", () => {
    const timers = installTimers()
    const [parent, cancelParent] = withCancel(background())
    let monotonicReads = 0
    setClock(
      () => 1_000,
      () => {
        monotonicReads += 1
        cancelParent()
        return 0
      }
    )

    const [ctx] = withDeadline(parent, new Date(2_000))

    expect(monotonicReads).toBe(1)
    expect(ctx.err()).toBe(canceled)
    expect(timers.delays).toEqual([])
  })

  test("cleans context resources when the timer constructor throws", () => {
    const failure = new Error("timer allocation failed")
    setClock(
      () => 1_000,
      () => 0
    )
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: (() => {
        throw failure
      }) as unknown as typeof setTimeout
    })

    expect(() => withDeadline(background(), new Date(2_000))).toThrow(failure)
  })

  test("ignores wall-clock jumps, re-arms early wakes, and expires at the monotonic target", () => {
    let wallReads = 0
    let wall = 1_000
    const monotonic = [10, 50, 110]
    setClock(
      () => {
        wallReads += 1
        return wall
      },
      () => monotonic.shift() ?? 110
    )
    const timers = installTimers()
    const [ctx] = withDeadline(background(), new Date(1_100))

    wall = 9_000_000
    timers.fire(0)
    expect(ctx.err()).toBeNull()
    expect(timers.delays).toEqual([100, 60])
    timers.fire(1)

    expect(ctx.err()).toBe(deadlineExceeded)
    expect(cause(ctx)).toBe(deadlineExceeded)
    expect(wallReads).toBe(1)
  })

  test("caps every timer arm at the platform maximum", () => {
    const monotonic = [0, 10]
    setClock(
      () => 0,
      () => monotonic.shift() ?? 10
    )
    const timers = installTimers()
    const [ctx, cancel] = withTimeout(background(), MaximumTimerDelay + 100)

    expect(timers.delays).toEqual([MaximumTimerDelay])
    timers.fire(0)
    expect(timers.delays).toEqual([MaximumTimerDelay, MaximumTimerDelay])
    expect(ctx.err()).toBeNull()
    cancel()
  })

  test("manual and parent cancellation clear the active timer and preserve the first cause", () => {
    setClock(
      () => 1_000,
      () => 0
    )
    const timers = installTimers()
    const deadlineCause = new Error("deadline")
    const [manual, cancelManual] = withDeadlineCause(background(), new Date(2_000), deadlineCause)
    cancelManual()
    timers.fire(0)

    expect(manual.err()).toBe(canceled)
    expect(cause(manual)).toBe(canceled)
    expect(timers.cleared).toContain(1)

    const [parent, cancelParent] = withCancelCause(background())
    const parentCause = new Error("parent")
    const [child] = withTimeoutCause(parent, 1_000, new Error("timeout"))
    cancelParent(parentCause)

    expect(child.err()).toBe(canceled)
    expect(cause(child)).toBe(parentCause)
    expect(timers.cleared).toContain(2)
  })
})
