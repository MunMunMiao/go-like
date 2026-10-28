import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import { background, type Context } from "@go-like/context"

import { newMemoryBroker, type MemoryBroker } from "../src/index"

const memory: MemoryBroker = newMemoryBroker()
const broker: Broker<void, void, void, null> = memory
const message: BrokerMessage = { headers: {}, body: new Uint8Array() }
const published: Promise<void> = memory.publish(background(), "events", message)
const subscribed: Promise<Subscriber> = memory.subscribe(
  background(),
  "events",
  (_ctx: Context, event: BrokerEvent<null>) => {
    const native: null = event.native
    void native
  }
)
const kind: "memory" = memory.string()

void [broker, kind, published, subscribed]

// @ts-expect-error Memory Broker has no queue-group options.
memory.subscribe(background(), "events", () => {}, { queue: "workers" })
// @ts-expect-error Memory Broker has no publish options.
memory.publish(background(), "events", message, { durable: true })
