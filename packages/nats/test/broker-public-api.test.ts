import { expect, test } from "bun:test"

import * as NatsBroker from "../src/broker"

test("NATS Core Broker entry exports the provider factory and drain timeout", () => {
  expect(Object.keys(NatsBroker).sort()).toEqual(["natsCoreDrainTimeout", "newNatsCoreBroker"])
})
