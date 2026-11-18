import { expect, test } from "bun:test"

import { background } from "../../src/context"
import { newScheduleServer } from "../../src/job/index"

test("a due time past the platform timer maximum is chained", async () => {
  const realNow = Date.now
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let now = 0
  const timers: { fn: () => void; ms: number }[] = []
  Date.now = () => now
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number) => {
    timers.push({
      fn: () => {
        if (typeof fn === "function") fn()
      },
      ms: ms ?? 0
    })
    return timers.length as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout
  const server = newScheduleServer(
    {
      next(afterMs: number) {
        return afterMs + 3_000_000_000
      },
      string: () => "interval"
    },
    "long",
    () => {}
  )
  const running = server.start(background())
  void running.catch(() => {})
  try {
    expect(timers[0]?.ms).toBe(2_147_483_647)
    const first = timers.shift()
    if (first === undefined) throw new Error("missing first timer")
    now += first.ms
    first.fn()
    expect(timers.at(-1)?.ms).toBe(3_000_000_000 - 2_147_483_647)
    const second = timers.pop()
    if (second === undefined) throw new Error("missing chained timer")
    now += second.ms
    second.fn()
    const stopping = server.stop(background())
    await stopping
    await running
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})
