import { expect, test } from "bun:test"

import * as NatsCore from "../src/index"

test("root runtime exports remain intentionally native-first", () => {
  expect(Object.keys(NatsCore).sort()).toEqual(["natsCoreDrainTimeout", "newNatsCoreServer"])
})
