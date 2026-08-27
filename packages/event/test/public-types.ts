import type { Broker, Subscriber } from "@go-like/broker"
import { background } from "@go-like/context"
import { eventBroker, type Codec, type EventBroker, type EventMessage } from "../src/index"

interface Value {
  readonly id: number
}

interface Native {
  ack(): void
}

const subscription: Subscriber = {
  topic: "events",
  unsubscribe: async () => {}
}
const broker: Broker<void, void, void, Native> = {
  publish: async () => {},
  subscribe: async () => subscription,
  string: () => "fixture"
}
const codec: Codec<Value> = {
  mediaType: "application/json",
  encode: (value) => new Uint8Array([value.id]),
  decode: (bytes) => ({ id: bytes[0] ?? 0 })
}
const typed: EventBroker<Value, void, void, void, Native> = eventBroker(broker, codec)
const subscribed: Promise<Subscriber> = typed.subscribe(
  background(),
  "events",
  (_ctx, event: EventMessage<Value, Native>) => {
    event.native.ack()
    const value: Value = event.decode()
    void value
  }
)
const published: Promise<void> = typed.publish(background(), "events", { id: 1 })

void [subscribed, published]

declare const message: EventMessage<Value, Native>
// @ts-expect-error Settlement belongs to native, not EventMessage.
message.ack()
