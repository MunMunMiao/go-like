import type { Broker, Subscriber } from "@likego/broker"
import { background } from "@likego/context"
import type { Channel, ConfirmChannel, ConsumeMessage, RecoveringChannelModel } from "amqplib"
import {
  newConfirmRabbitMqBroker,
  newRabbitMqBroker,
  newRecoveringRabbitMqBroker,
  type RabbitMqBroker,
  type RabbitMqPublishOptions,
  type RabbitMqRecoveryConnector,
  type RabbitMqSubscribeOptions,
  type RecoveringRabbitMqBroker
} from "../src/index"

declare const channel: Channel
declare const confirmChannel: ConfirmChannel

const broker: Broker<RabbitMqPublishOptions, boolean, RabbitMqSubscribeOptions, ConsumeMessage> =
  newRabbitMqBroker(channel)
const published: Promise<boolean> = broker.publish(
  background(),
  "events",
  { headers: {}, body: new Uint8Array() },
  { exchange: "events", routingKey: "events.created", properties: { persistent: true } }
)
const subscribed: Promise<Subscriber> = broker.subscribe(
  background(),
  "events.*",
  (_ctx, event) => {
    const native: ConsumeMessage = event.native
    channel.ack(native)
  },
  {
    exchange: { name: "events", type: "topic", options: { durable: true } },
    queue: { name: "workers", options: { durable: true } },
    consume: { noAck: false }
  }
)

void [published, subscribed]

const confirmed: RabbitMqBroker = newConfirmRabbitMqBroker(confirmChannel)
const confirmedPublish: Promise<boolean> = confirmed.publish(background(), "events", {
  headers: {},
  body: new Uint8Array()
})
void confirmedPublish

const connector: RabbitMqRecoveryConnector = async (_setup) => {
  return {} as RecoveringChannelModel
}
const recovering: Promise<RecoveringRabbitMqBroker> = newRecoveringRabbitMqBroker(
  background(),
  connector
)
async function consumeRecovery(): Promise<void> {
  const recovered = await recovering
  const stable: RabbitMqBroker = recovered.broker
  void stable
}
function useSettlement(stable: RabbitMqBroker, native: ConsumeMessage): void {
  stable.ack(native)
  stable.nack(native, false, true)
  stable.reject(native, false)
}
void recovering
void consumeRecovery
void useSettlement

// @ts-expect-error BrokerMessage is the only public header source.
const invalidProperties: RabbitMqPublishOptions = { properties: { headers: {} } }
void invalidProperties
