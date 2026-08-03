import { expect, test } from "bun:test"

import * as EventPackage from "../src/index"

test("public runtime API exposes only typed wrappers without settlement policy", () => {
  expect(Object.keys(EventPackage)).toEqual(["eventBroker"])
  expect("ack" in EventPackage).toBe(false)
  expect("nak" in EventPackage).toBe(false)
  expect("term" in EventPackage).toBe(false)
})
