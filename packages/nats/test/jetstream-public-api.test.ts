import { expect, test } from "bun:test"

import * as NatsJetStream from "../src/jetstream"

test("JetStream entry exports the provider factory and close timeout", () => {
  expect(Object.keys(NatsJetStream).sort()).toEqual([
    "natsJetStreamCloseTimeout",
    "newNatsJetStreamBroker"
  ])
})
