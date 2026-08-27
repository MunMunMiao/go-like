import { expect, test } from "bun:test"

import * as NatsJetStream from "../src/jetstream"

test("JetStream subpath runtime exports remain intentionally native-first", () => {
  expect(Object.keys(NatsJetStream).sort()).toEqual([
    "natsJetStreamCloseTimeout",
    "newNatsJetStreamServer"
  ])
})
