import { background } from "@go-like/context"
import type { Server } from "@go-like/core"
import type { ConsumerMessages } from "@nats-io/jetstream"
import {
  natsJetStreamCloseTimeout,
  newNatsJetStreamServer,
  type NatsJetStreamAlreadyStartedError,
  type NatsJetStreamCloseTimeoutError,
  type NatsJetStreamMessagesFactory,
  type NatsJetStreamMessagesSource,
  type NatsJetStreamUnexpectedExitError
} from "../src/jetstream"

declare const messages: ConsumerMessages

const factory: NatsJetStreamMessagesFactory = async () => messages
const directSource: NatsJetStreamMessagesSource = messages
const factorySource: NatsJetStreamMessagesSource = factory
const directServer: Server = newNatsJetStreamServer(directSource)
const factoryServer: Server = newNatsJetStreamServer(
  factorySource,
  natsJetStreamCloseTimeout(25_000)
)
const accepted: Promise<void> = directServer.start(background())
const acceptedFactory: Promise<void> = factoryServer.start(background())
const stopping: Promise<void> = directServer.stop(background())
const alreadyStarted: NatsJetStreamAlreadyStartedError | null = null
const unexpectedExit: NatsJetStreamUnexpectedExitError | null = null
const closeTimeout: NatsJetStreamCloseTimeoutError | null = null

void accepted
void acceptedFactory
void stopping
void alreadyStarted
void unexpectedExit
void closeTimeout

// @ts-expect-error Lifecycle-only factories do not receive a go-like Context.
const contextFactory: NatsJetStreamMessagesFactory = (_ctx) => messages
void contextFactory

// @ts-expect-error The adapter accepts ConsumerMessages, not a client/consumer/handler tuple.
newNatsJetStreamServer({}, "EVENTS", "worker", () => {})
