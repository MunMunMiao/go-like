import type { Broker, Subscriber } from "@go-like/broker"
import { background } from "@go-like/context"
import type { Msg, NatsConnection } from "@nats-io/transport-node"
import {
  newNatsCoreBroker,
  type NatsCoreBrokerPublishOptions,
  type NatsCoreBrokerSubscribeOptions
} from "../src/broker"

declare const connection: NatsConnection

const broker: Broker<NatsCoreBrokerPublishOptions, void, NatsCoreBrokerSubscribeOptions, Msg> =
  newNatsCoreBroker(connection)
const published: Promise<void> = broker.publish(
  background(),
  "events",
  { headers: {}, body: new Uint8Array() },
  { reply: "reply" }
)
const subscribed: Promise<Subscriber> = broker.subscribe(
  background(),
  "events",
  (_ctx, event) => {
    const native: Msg = event.native
    void native
  },
  { queue: "workers" }
)

void [published, subscribed]

// @ts-expect-error BrokerMessage is the only public header source.
const invalidPublishOptions: NatsCoreBrokerPublishOptions = { headers: undefined }
// @ts-expect-error go-like owns the iterator callback.
const invalidSubscribeOptions: NatsCoreBrokerSubscribeOptions = { callback: () => {} }
void [invalidPublishOptions, invalidSubscribeOptions]
