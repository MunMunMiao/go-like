import assert from "node:assert/strict"
import process from "node:process"

import { newCronerSchedule } from "@go-like/croner/job"

const before = process.getActiveResourcesInfo().filter((item) => item === "Timeout").length
const schedule = newCronerSchedule("* * * * * *", { timezone: "UTC" })
const after = process.getActiveResourcesInfo().filter((item) => item === "Timeout").length
assert.equal(schedule.string(), "croner")
assert.equal(schedule.next(1_000), 2_000)
assert.equal(after, before)
assert.deepEqual(Object.keys(await import("@go-like/croner/job")), ["newCronerSchedule"])
