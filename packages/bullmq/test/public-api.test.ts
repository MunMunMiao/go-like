import { expect, test } from "bun:test"

import * as BullmqJob from "../src/job/index"

test("bullmq job exposes only the queue factory", () => {
  expect(Object.keys(BullmqJob).sort()).toEqual(["newBullMqJobQueue"])
  expect(typeof BullmqJob.newBullMqJobQueue).toBe("function")
})
