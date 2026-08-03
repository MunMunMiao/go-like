import { background } from "@likego/context"
import type { Server } from "@likego/core"
import type { Subscription } from "@nats-io/transport-node"
import {
  natsCoreDrainTimeout,
  newNatsCoreServer,
  type NatsCoreAlreadyStartedError,
  type NatsCoreDrainTimeoutError,
  type NatsCoreSubscriptionFactory,
  type NatsCoreSubscriptionSource,
  type NatsCoreUnexpectedExitError
} from "../src/index"

declare const subscription: Subscription

const factory: NatsCoreSubscriptionFactory = async () => subscription
const directSource: NatsCoreSubscriptionSource = subscription
const factorySource: NatsCoreSubscriptionSource = factory
const directServer: Server = newNatsCoreServer(directSource)
const factoryServer: Server = newNatsCoreServer(factorySource, natsCoreDrainTimeout(25_000))
const accepted: Promise<void> = directServer.start(background())
const acceptedFactory: Promise<void> = factoryServer.start(background())
const stopping: Promise<void> = directServer.stop(background())
const alreadyStarted: NatsCoreAlreadyStartedError | null = null
const unexpectedExit: NatsCoreUnexpectedExitError | null = null
const drainTimeout: NatsCoreDrainTimeoutError | null = null

void accepted
void acceptedFactory
void stopping
void alreadyStarted
void unexpectedExit
void drainTimeout

// @ts-expect-error Lifecycle-only factories do not receive a LikeGo Context.
const contextFactory: NatsCoreSubscriptionFactory = (_ctx) => subscription
void contextFactory

// @ts-expect-error The adapter accepts an official Subscription, not a connection and handler tuple.
newNatsCoreServer({}, "events.created", () => {})
