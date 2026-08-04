import { background, type Context } from "@go-like/context"
import type { Server } from "@go-like/core"
import {
  newBrokerServer,
  type Broker,
  type BrokerEvent,
  type BrokerMessage,
  type Subscriber
} from "../src/index"
import { registerSubscriberTerminal, subscriberTerminal } from "../src/provider"

interface Native {
  readonly delivery: string
}

interface PublishOptions {
  readonly reply: string
}

interface SubscribeOptions {
  readonly queue: string
}

const nativeSubscription: Subscriber = {
  topic: "events",
  unsubscribe: async (_ctx) => {}
}
const broker: Broker<PublishOptions, number, SubscribeOptions, Native> = {
  publish: async (_ctx, _topic, _message) => 1,
  subscribe: async (_ctx, _topic, _handler) => nativeSubscription,
  string: () => "fixture"
}
const message: BrokerMessage = { headers: {}, body: new Uint8Array() }
const event: BrokerEvent<Native> = { topic: "events", message, native: { delivery: "1" } }
const server: Server = newBrokerServer(
  broker,
  "events",
  (_ctx: Context, _event: BrokerEvent<Native>) => {},
  { queue: "workers" }
)
const subscribed: Promise<Subscriber> = broker.subscribe(
  background(),
  "events",
  (_ctx, _event) => {},
  { queue: "workers" }
)
const running: Promise<void> = server.start(background())
const stopping: Promise<void> = server.stop(background())
const published: Promise<number> = broker.publish(background(), "events", message, { reply: "x" })
const providerSubscriber: Subscriber = registerSubscriberTerminal(
  nativeSubscription,
  Promise.resolve()
)
const providerTerminal: Promise<void> | null = subscriberTerminal(providerSubscriber)

void [event, running, stopping, published, subscribed, providerSubscriber, providerTerminal]

// @ts-expect-error Broker does not invent native acknowledgement methods.
event.ack()
// @ts-expect-error Publish result remains provider-specific.
const invalid: Promise<void> = published
void invalid
