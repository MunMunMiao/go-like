import type { Broker, Subscriber } from "@go-like/core/broker"
import { background } from "@go-like/core/context"
import type { ConsumerMessages, JetStreamClient, JsMsg, PubAck } from "@nats-io/jetstream"
import {
  newNatsJetStreamBroker,
  type NatsJetStreamBroker,
  type NatsJetStreamBrokerMessagesFactory,
  type NatsJetStreamBrokerPublishOptions
} from "../src/jetstream"

interface SubscribeOptions {
  readonly durable: string
}

declare const client: JetStreamClient
declare const messages: ConsumerMessages

const factory: NatsJetStreamBrokerMessagesFactory<SubscribeOptions> = async (
  _ctx,
  _topic,
  _options
) => messages
const broker: NatsJetStreamBroker<SubscribeOptions> = newNatsJetStreamBroker(client, factory)
const brokerSocket: Broker<NatsJetStreamBrokerPublishOptions, PubAck, SubscribeOptions, JsMsg> =
  broker
const published: Promise<PubAck> = broker.publish(
  background(),
  "events",
  { headers: {}, body: new Uint8Array() },
  { msgID: "1" }
)
const subscribed: Promise<Subscriber> = broker.subscribe(
  background(),
  "events",
  (_ctx, event) => {
    event.native.ack()
    event.native.nak()
    event.native.term()
  },
  { durable: "worker" }
)

void [brokerSocket, published, subscribed]

// @ts-expect-error BrokerMessage is the only public header source.
const invalidOptions: NatsJetStreamBrokerPublishOptions = { headers: undefined }
void invalidOptions
