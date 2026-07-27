import { expect, test } from "bun:test"

import * as NatsBroker from "../src/broker"

test("NATS Core Broker subpath exports only the typed provider factory", () => {
  expect(Object.keys(NatsBroker)).toEqual(["newNatsCoreBroker"])
})
