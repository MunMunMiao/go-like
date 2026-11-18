import { describe, expect, test } from "bun:test"
import process from "node:process"

import { background } from "@go-like/core/context"
import { newScheduleServer } from "@go-like/core/job"
import { AttributeKey, withTelemetry } from "@go-like/core/telemetry"
import {
  jobTelemetryConformance,
  newTelemetryRecorder,
  scheduleConformance
} from "@go-like/core/testing"
import { Cron } from "croner"

import { newCronerSchedule, type CronerScheduleOptions } from "../src/job/index"

const everySecond = "* * * * * *"

describe("Croner schedule", () => {
  test("rejects a bad pattern, owned options, and illegal due times", () => {
    expect(() => newCronerSchedule("")).toThrow("non-empty")
    expect(() => newCronerSchedule(1 as never)).toThrow(TypeError)
    expect(() => newCronerSchedule(everySecond, null as never)).toThrow("object")
    expect(() => newCronerSchedule(everySecond, 1 as never)).toThrow("object")
    expect(() => newCronerSchedule(everySecond, { paused: true } as never)).toThrow(
      "owned by the go-like schedule server"
    )
    expect(() => newCronerSchedule("not a cron")).toThrow()
    const schedule = newCronerSchedule(everySecond)
    expect(() => schedule.next(-1)).toThrow(RangeError)
    expect(() => schedule.next(1.5)).toThrow(RangeError)
  })

  test("computes a pure timetable without starting Croner", () => {
    const before = process.getActiveResourcesInfo().filter((item) => item === "Timeout").length
    const options: CronerScheduleOptions = { timezone: "UTC" }
    const schedule = newCronerSchedule(everySecond, options)
    const after = process.getActiveResourcesInfo().filter((item) => item === "Timeout").length
    const probe = new Cron(everySecond, { ...options })
    expect(probe.isRunning()).toBe(false)
    expect(after).toBe(before)
    expect(Object.isFrozen(schedule)).toBe(true)
    expect(schedule.string()).toBe("croner")
    const first = schedule.next(1_000)
    expect(first).toBe(2_000)
    expect(schedule.next(1_000)).toBe(first)
    const exhausted = newCronerSchedule(everySecond, { stopAt: new Date(0) })
    expect(exhausted.next(1_000)).toBeNull()
  })

  test("satisfies the schedule conformance suite", async () => {
    const cases = scheduleConformance(() => newCronerSchedule(everySecond))
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) await entry.run()
  })

  test("satisfies the schedule telemetry cases", async () => {
    const cases = jobTelemetryConformance({ schedule: newCronerSchedule(everySecond) })
    expect(cases.length).toBeGreaterThan(0)
    for (const entry of cases) await entry.run()
  })

  test("a triggered run records the croner system on a root span", async () => {
    const recorder = newTelemetryRecorder()
    const ctx = withTelemetry(background(), recorder.telemetry)
    const server = newScheduleServer(newCronerSchedule("0 0 0 1 1 *"), "tick", () => {})
    const running = server.start(ctx)
    try {
      await server.trigger(ctx)
      const run = recorder.spans().find((span) => span.name === "run tick")
      expect(run?.root).toBe(true)
      expect(run?.parent).toBeNull()
      expect(run?.attributes[AttributeKey.jobSystem]).toBe("croner")
      expect(run?.attributes[AttributeKey.jobTrigger]).toBe("schedule")
    } finally {
      await server.stop(background())
      await running
    }
  })
})
