import type { NatsConnection } from "@nats-io/transport-node"
import {
  natsCoreDrainTimeout,
  newNatsCoreBroker,
  type NatsCoreDrainTimeoutError,
  type NatsCoreOption,
  type NatsCoreUnexpectedExitError
} from "../src/broker"

declare const connection: NatsConnection

const option: NatsCoreOption = natsCoreDrainTimeout(25_000)
const broker = newNatsCoreBroker(connection, option, natsCoreDrainTimeout(0))
const unexpectedExit: NatsCoreUnexpectedExitError | null = null
const drainTimeout: NatsCoreDrainTimeoutError | null = null

void broker.string()
void unexpectedExit
void drainTimeout
