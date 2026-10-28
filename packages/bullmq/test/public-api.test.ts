import { expect, test } from "bun:test"

import * as publicApi from "../src/index"

test("exports only the frozen BullMQ worker runtime API", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "bullMqWorkerShutdownTimeout",
    "newBullMqWorkerServer"
  ])
})
