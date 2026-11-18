import assert from "node:assert/strict"
import { createRequire } from "node:module"
import process from "node:process"

import { newCronerSchedule } from "@go-like/croner/job"

const require = createRequire(import.meta.url)
const cronerPackage = require("croner/package.json") as { readonly version: string }
assert.equal(cronerPackage.version, "11.0.0")
const before = process.getActiveResourcesInfo().filter((item) => item === "Timeout").length
const schedule = newCronerSchedule("0 0 0 1 1 *", { timezone: "UTC" })
const due = schedule.next(0)
assert.equal(typeof due, "number")
assert.equal((due ?? 0) > 0, true)
assert.equal(schedule.string(), "croner")
const after = process.getActiveResourcesInfo().filter((item) => item === "Timeout").length
assert.equal(after, before)
