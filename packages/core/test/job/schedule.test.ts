import { expect, test } from "bun:test"

import { background, withCancelCause } from "../../src/context"
import { newIntervalSchedule, newScheduleServer, type Schedule } from "../../src/job/index"

/** Waits until `predicate` holds. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

/** A timetable whose next due time is a fixed offset. */
function offset(ms: number): Schedule {
  return Object.freeze({
    next(afterMs: number): number {
      return afterMs + ms
    },
    string(): string {
      return "interval"
    }
  })
}

test("manual triggers do not overlap a run or each other", async () => {
  let active = 0
  let max = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = newScheduleServer(offset(60_000), "manual", async () => {
    active += 1
    max = Math.max(max, active)
    await gate
    active -= 1
  })
  const running = server.start(background())
  void running.catch(() => {})
  try {
    const first = server.trigger(background())
    await until(() => active === 1, 1_000)
    const nested = server.trigger(background())
    const third = server.trigger(background())
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(max).toBe(1)
    expect(active).toBe(1)
    release()
    await first
    await nested
    await third
    expect(max).toBe(1)
  } finally {
    release()
    await server.stop(background())
    await running
  }
})

test("a due time during a run is skipped instead of caught up", async () => {
  let runs = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = newScheduleServer(offset(15), "skip", async () => {
    runs += 1
    if (runs === 1) await gate
  })
  const running = server.start(background())
  void running.catch(() => {})
  try {
    await until(() => runs === 1, 1_000)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(runs).toBe(1)
    release()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 8)
    })
    expect(runs).toBe(1)
    await until(() => runs >= 2, 1_000)
    expect(runs).toBeLessThan(5)
  } finally {
    release()
    await server.stop(background())
    await running
  }
})

test("caller cancellation does not finish the owner drain", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  const server = newScheduleServer(offset(60_000), "drain", async () => {
    started = true
    await gate
  })
  const running = server.start(background())
  void running.catch(() => {})
  try {
    const trigger = server.trigger(background())
    await until(() => started, 1_000)
    const [stopCtx, cancel] = withCancelCause(background())
    const reason = new Error("caller stopped waiting")
    const waiting = server.stop(stopCtx)
    cancel(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(started).toBe(true)
    release()
    await trigger
    await running
  } finally {
    release()
    await server.stop(background()).catch(() => {})
    await running.catch(() => {})
  }
})

test("stopping during a run times out and then settles when the run ends", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  const server = newScheduleServer(
    offset(60_000),
    "timeout",
    async () => {
      started = true
      await gate
    },
    { drainTimeoutMs: 40 }
  )
  const running = server.start(background())
  void running.catch(() => {})
  try {
    const triggered = server.trigger(background())
    void triggered.catch(() => {})
    await until(() => started, 1_000)
    await expect(server.stop(background())).rejects.toMatchObject({
      name: "JobDrainTimeoutError",
      code: "GO_LIKE_JOB_DRAIN_TIMEOUT"
    })
    release()
    await expect(running).rejects.toMatchObject({ code: "GO_LIKE_JOB_DRAIN_TIMEOUT" })
  } finally {
    release()
  }
})

test("rejects operations that the state does not allow", async () => {
  const server = newScheduleServer(offset(60_000), "state", () => {})
  await expect(server.trigger(background())).rejects.toMatchObject({
    name: "JobStateError",
    operation: "trigger",
    state: "idle"
  })
  const [canceled, cancel] = withCancelCause(background())
  const reason = new Error("start canceled")
  cancel(reason)
  await expect(server.start(canceled)).rejects.toBe(reason)
  const replacement = newScheduleServer(offset(60_000), "state", () => {})
  const running = replacement.start(background())
  void running.catch(() => {})
  await expect(replacement.start(background())).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE" })
  await replacement.stop(background())
  await running
  await expect(replacement.trigger(background())).rejects.toMatchObject({ state: "stopped" })
  await expect(replacement.start(background())).rejects.toMatchObject({ state: "stopped" })
})

test("a corrupt or exhausted timetable fails or stays idle", async () => {
  const broken = newScheduleServer(
    {
      next() {
        throw new Error("bad timetable")
      },
      string: () => "interval"
    },
    "broken",
    () => {}
  )
  await expect(broken.start(background())).rejects.toThrow("bad timetable")
  const illegal = newScheduleServer(
    {
      next(after: number) {
        return after
      },
      string: () => "interval"
    },
    "illegal",
    () => {}
  )
  await expect(illegal.start(background())).rejects.toThrow("illegal due time")
  await illegal.stop(background())
  const fractional = newScheduleServer(
    {
      next() {
        return 1.5
      },
      string: () => "interval"
    },
    "fraction",
    () => {}
  )
  await expect(fractional.start(background())).rejects.toThrow("illegal due time")
  await fractional.stop(background())
  const text = newScheduleServer(
    {
      next() {
        throw "bad"
      },
      string: () => "interval"
    },
    "text",
    () => {}
  )
  await expect(text.start(background())).rejects.toThrow("schedule next failed")
  await text.stop(background())
  let runs = 0
  const exhausted = newScheduleServer(
    {
      next() {
        return null
      },
      string: () => "interval"
    },
    "done",
    () => {
      runs += 1
    }
  )
  const running = exhausted.start(background())
  void running.catch(() => {})
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20)
  })
  expect(runs).toBe(0)
  await exhausted.stop(background())
  await running
})

test("rejects a schedule that does not name itself", async () => {
  expect(() =>
    newScheduleServer(
      {
        next: () => null,
        string: () => ""
      },
      "job",
      () => {}
    )
  ).toThrow(TypeError)
  expect(() => newScheduleServer(offset(10), "", () => {})).toThrow(TypeError)
  expect(() => newIntervalSchedule(-1)).toThrow(RangeError)
  const aligned = newIntervalSchedule(10_000)
  expect(aligned.next(0)).toBe(10_000)
  expect(aligned.next(10_000)).toBe(20_000)
  expect(aligned.string()).toBe("interval")
  const wide = newIntervalSchedule(Number.MAX_SAFE_INTEGER)
  expect(() => wide.next(Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
  expect(() => newScheduleServer(null as never, "job", () => {})).toThrow(TypeError)
  expect(() => newScheduleServer(offset(10), "job", "no" as never)).toThrow(TypeError)
  expect(() => newScheduleServer(offset(10), "job", () => {}, null as never)).toThrow(TypeError)
  expect(() =>
    newScheduleServer(
      {
        next: () => null,
        string: () => 1 as never
      },
      "job",
      () => {}
    )
  ).toThrow(TypeError)
  const [early, cancelEarly] = withCancelCause(background())
  const earlyReason = new Error("trigger canceled")
  cancelEarly(earlyReason)
  const armed = newScheduleServer(offset(60_000), "armed", () => {})
  const armedRun = armed.start(background())
  void armedRun.catch(() => {})
  try {
    await expect(armed.trigger(early)).rejects.toBe(earlyReason)
  } finally {
    await armed.stop(background())
    await armedRun
  }
})

test("stop rejects a manual run that has not started", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = 0
  const server = newScheduleServer(offset(60_000), "queued", async () => {
    started += 1
    await gate
  })
  const running = server.start(background())
  void running.catch(() => {})
  const first = server.trigger(background())
  void first.catch(() => {})
  try {
    await until(() => started === 1, 1_000)
    const second = server.trigger(background())
    const stopping = server.stop(background())
    await expect(second).rejects.toMatchObject({ code: "GO_LIKE_JOB_STATE", state: "stopping" })
    release()
    await first
    await stopping
    await running
  } finally {
    release()
    await server.stop(background()).catch(() => {})
    await running.catch(() => {})
  }
})

test("stop from a synchronous handler waits for that handler", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let stopped = false
  let stopping: Promise<void> | undefined
  const server = newScheduleServer(
    { next: (after) => after + 60_000, string: () => "probe" },
    "work",
    () => {
      stopping = server.stop(background())
      void stopping.then(() => {
        stopped = true
      })
      return gate
    },
    { drainTimeoutMs: 1_000 }
  )
  const running = server.start(background())
  const triggered = server.trigger(background())
  try {
    await until(() => stopping !== undefined, 1_000)
    expect(stopped).toBe(false)
  } finally {
    release()
    await triggered
    await server.stop(background())
    await running
  }
})

test("a timetable failure before the handler rejects the trigger", async () => {
  let calls = 0
  const server = newScheduleServer(
    {
      next(after) {
        calls += 1
        if (calls >= 2) throw new Error("before handler")
        return after + 60_000
      },
      string: () => "probe"
    },
    "work",
    () => {
      throw new Error("handler ran")
    }
  )
  const running = server.start(background())
  await expect(server.trigger(background())).rejects.toThrow("before handler")
  await expect(running).rejects.toThrow("before handler")
  await server.stop(background())
})

test("a timetable failure keeps ownership of the active handler", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let notifyFailure!: () => void
  const failed = new Promise<void>((resolve) => {
    notifyFailure = resolve
  })
  let nextCalls = 0
  let entered = false
  let runtimeSettled = false
  let stopSettled = false
  const server = newScheduleServer(
    {
      next(after) {
        if (++nextCalls === 3) {
          notifyFailure()
          throw new Error("timetable broken")
        }
        return after + 5
      },
      string: () => "probe"
    },
    "work",
    () => {
      entered = true
      return gate
    },
    { drainTimeoutMs: 1_000 }
  )
  const running = server.start(background())
  const terminal = running.then(
    () => {
      runtimeSettled = true
    },
    () => {
      runtimeSettled = true
    }
  )
  let stopping: Promise<void> | undefined
  try {
    await failed
    stopping = server.stop(background())
    void stopping.then(
      () => {
        stopSettled = true
      },
      () => {
        stopSettled = true
      }
    )
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(entered).toBe(true)
    expect(runtimeSettled).toBe(false)
    expect(stopSettled).toBe(false)
  } finally {
    release()
    await stopping?.catch(() => {})
    await terminal
  }
})

test("stop after a timetable failure honors a zero drain budget", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let notifyFailure!: () => void
  const failed = new Promise<void>((resolve) => {
    notifyFailure = resolve
  })
  const timetable = new Error("timetable broken")
  let nextCalls = 0
  const server = newScheduleServer(
    {
      next(after) {
        if (++nextCalls === 3) {
          notifyFailure()
          throw timetable
        }
        return after + 5
      },
      string: () => "probe"
    },
    "work",
    () => gate,
    { drainTimeoutMs: 0 }
  )
  const running = server.start(background())
  try {
    await failed
    const stopError = await Promise.race([
      server.stop(background()).then(
        () => "resolved",
        (error: unknown) => error
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("hung")
        }, 300)
      })
    ])
    expect(stopError).toMatchObject({
      name: "JobDrainTimeoutError",
      code: "GO_LIKE_JOB_DRAIN_TIMEOUT"
    })
    let runtimeSettled = false
    void running.then(
      () => {
        runtimeSettled = true
      },
      () => {
        runtimeSettled = true
      }
    )
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(runtimeSettled).toBe(false)
    release()
    const started = await running.then(
      () => "resolved",
      (error: unknown) => error
    )
    expect(started).toBeInstanceOf(AggregateError)
    if (!(started instanceof AggregateError)) return
    expect(started.errors[0]).toBe(timetable)
    expect(started.errors[1]).toBe(stopError)
  } finally {
    release()
    await server.stop(background()).catch(() => {})
    await running.catch(() => {})
  }
})

test("a timetable failure within the drain budget keeps the original error", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let notifyFailure!: () => void
  const failed = new Promise<void>((resolve) => {
    notifyFailure = resolve
  })
  const timetable = new Error("timetable broken")
  let nextCalls = 0
  const server = newScheduleServer(
    {
      next(after) {
        if (++nextCalls === 3) {
          notifyFailure()
          throw timetable
        }
        return after + 5
      },
      string: () => "probe"
    },
    "work",
    () => gate,
    { drainTimeoutMs: 1_000 }
  )
  const running = server.start(background())
  let stopping: Promise<void> | undefined
  try {
    await failed
    stopping = server.stop(background())
    release()
    await stopping
    await expect(running).rejects.toBe(timetable)
  } finally {
    release()
    await stopping?.catch(() => {})
    await running.catch(() => {})
  }
})
