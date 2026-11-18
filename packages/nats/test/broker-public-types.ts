import type { Broker, Subscriber } from "@go-like/core/broker"
import { background } from "@go-like/core/context"
import type { Msg, NatsConnection } from "@nats-io/transport-node"
import {
  newNatsCoreBroker,
  type NatsCoreBroker,
  type NatsCoreBrokerPublishOptions,
  type NatsCoreBrokerSubscribeOptions
} from "../src/broker"

declare const connection: NatsConnection

const broker: NatsCoreBroker = newNatsCoreBroker(connection)
const brokerSocket: Broker<
  NatsCoreBrokerPublishOptions,
  void,
  NatsCoreBrokerSubscribeOptions,
  Msg
> = broker
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

void [brokerSocket, published, subscribed]

// @ts-expect-error BrokerMessage is the only public header source.
const invalidPublishOptions: NatsCoreBrokerPublishOptions = { headers: undefined }
// @ts-expect-error go-like owns the iterator callback.
const invalidSubscribeOptions: NatsCoreBrokerSubscribeOptions = { callback: () => {} }
void [invalidPublishOptions, invalidSubscribeOptions]
