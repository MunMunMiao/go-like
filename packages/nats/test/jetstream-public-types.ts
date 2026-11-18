import type { JetStreamClient } from "@nats-io/jetstream"
import {
  natsJetStreamCloseTimeout,
  newNatsJetStreamBroker,
  type NatsJetStreamCloseTimeoutError,
  type NatsJetStreamOption,
  type NatsJetStreamUnexpectedExitError
} from "../src/jetstream"

declare const client: JetStreamClient

const option: NatsJetStreamOption = natsJetStreamCloseTimeout(25_000)
const broker = newNatsJetStreamBroker(
  client,
  () => {
    throw new Error("unused")
  },
  option,
  natsJetStreamCloseTimeout(0)
)
const unexpectedExit: NatsJetStreamUnexpectedExitError | null = null
const closeTimeout: NatsJetStreamCloseTimeoutError | null = null

void broker.string()
void unexpectedExit
void closeTimeout
