import { expect, test } from "bun:test"

import * as CronerJob from "../src/job/index"

test("croner job exposes only the schedule factory", () => {
  expect(Object.keys(CronerJob).sort()).toEqual(["newCronerSchedule"])
  expect(typeof CronerJob.newCronerSchedule).toBe("function")
})
