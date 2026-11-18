import { expect, test } from "bun:test"

import { newBrokerEvent } from "@go-like/core/broker/provider"
import { background, type Context } from "@go-like/core/context"
import type { Broker } from "@go-like/core/broker"

import { isolatedCases } from "./conformance-subject"

/** Fan-out bus that keeps every subscriber until that subscriber unsubscribes. */
function sharedBus(): Broker<void, void, void, null> {
  const handlers = new Map<string, Set<(body: Uint8Array) => void>>()
  return {
    string: () => "fanout",
    async publish(
      _ctx: Context,
      topic: string,
      message: { readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }
    ) {
      const group = handlers.get(topic)
      if (group === undefined) return
      for (const deliver of group) deliver(message.body)
    },
    async subscribe(
      _ctx: Context,
      topic: string,
      handler: (
        ctx: Context,
        event: ReturnType<typeof newBrokerEvent<null>>
      ) => void | Promise<void>
    ) {
      let group = handlers.get(topic)
      if (group === undefined) {
        group = new Set()
        handlers.set(topic, group)
      }
      const deliver = (body: Uint8Array): void => {
        void handler(background(), newBrokerEvent(topic, {}, body, null))
      }
      group.add(deliver)
      return {
        topic,
        async unsubscribe() {
          group.delete(deliver)
        }
      }
    }
  }
}

test("a later conformance case is not delivered to an earlier subscriber", async () => {
  const bus = sharedBus()
  const released: string[] = []
  const next = isolatedCases(
    "orders",
    async () => bus,
    async (topic) => {
      released.push(topic)
    }
  )
  const seen: string[] = []
  const first = next()
  const firstBroker = await first.newBroker(background())
  await firstBroker.subscribe(background(), first.topic, (_ctx, event) => {
    seen.push(new TextDecoder().decode(event.message.body))
  })
  await first.close(background())
  const second = next()
  const later = await second.newBroker(background())
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
  await later.publish(background(), second.topic, { headers: {}, body: encode("later") })
  await later.publish(background(), first.topic, { headers: {}, body: encode("stale-topic") })
  expect(seen).not.toContain("later")
  expect(seen).not.toContain("stale-topic")
  expect(second.topic).not.toBe(first.topic)
  expect(released).toEqual([first.topic])
  await second.close(background())
})
