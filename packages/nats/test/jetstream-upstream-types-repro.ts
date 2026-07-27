import type { Consumer, ConsumerMessages, JetStreamClient, JsMsg, PubAck } from "@nats-io/jetstream"

declare const client: JetStreamClient
declare const consumer: Consumer
declare const messages: ConsumerMessages
declare const message: JsMsg

const consumerOperation: Promise<Consumer> = client.consumers.get("EVENTS", "events-worker")
const messagesOperation: Promise<ConsumerMessages> = consumer.consume({ max_messages: 1 })
const publishOperation: Promise<PubAck> = client.publish("events.dlq", message.data, {
  msgID: "likego-dlq:EVENTS:events-worker:1"
})
const closeOperation: Promise<void | Error> = messages.close()

void consumerOperation
void messagesOperation
void publishOperation
void closeOperation
