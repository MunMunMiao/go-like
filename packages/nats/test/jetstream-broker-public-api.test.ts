import { expect, test } from "bun:test"

import * as NatsJetStreamBroker from "../src/jetstream-broker"

test("NATS JetStream Broker subpath exports only the typed provider factory", () => {
  expect(Object.keys(NatsJetStreamBroker)).toEqual(["newNatsJetStreamBroker"])
})
