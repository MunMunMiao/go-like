import { describe, expect, test } from "bun:test"

import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import { background, type Context } from "@go-like/context"

import { eventBroker, type Codec, type EventMessage } from "../src/index"

interface Value {
  readonly id: number
}

interface Native {
  readonly delivery: string
}

interface Options {
  readonly queue: string
}

/** Creates one stable native subscription. */
function nativeSubscription(topic: string): Subscriber {
  return Object.freeze({
    topic,
    unsubscribe() {
      return Promise.resolve()
    }
  })
}

describe("typed Event Broker", () => {
  test("encodes once, detaches bytes, preserves media type, options, and native publish result", async () => {
    const encoded = new Uint8Array([7, 8])
    const result = Object.freeze({ sequence: 42 })
    const observed: BrokerMessage[] = []
    const argumentsSeen: number[] = []
    const broker: Broker<Options, typeof result, Options, Native> = {
      async publish(_ctx, _topic, message) {
        argumentsSeen.push(arguments.length)
        observed.push(message)
        const first = message.body
        first[0] = 99
        expect(Array.from(message.body)).toEqual([7, 8])
        return result
      },
      async subscribe() {
        return nativeSubscription("topic")
      },
      string() {
        return "controlled"
      }
    }
    let encodeReceiver = ""
    const codec = {
      identity: "codec-receiver",
      mediaType: "application/example+json",
      encode(_value: Value) {
        encodeReceiver = this.identity
        return encoded
      },
      decode() {
        return { id: 0 }
      }
    } satisfies Codec<Value> & { identity: string }
    const typed = eventBroker(broker, codec)
    codec.encode = function mutated() {
      throw new Error("mutated encoder must not run")
    }

    expect(await typed.publish(background(), "topic", { id: 7 }, { queue: "workers" })).toBe(result)
    encoded[0] = 1
    expect(encodeReceiver).toBe("codec-receiver")
    expect(argumentsSeen).toEqual([4])
    expect(observed[0]?.headers).toEqual({ "content-type": "application/example+json" })
    expect(Object.isFrozen(observed[0]?.headers)).toBe(true)
    expect(Array.from(observed[0]?.body ?? [])).toEqual([7, 8])
  })

  test("delays decode, supplies fresh bytes, preserves native identity, and returns exact subscription", async () => {
    const native = Object.freeze({ delivery: "native-js-msg" })
    const subscription = nativeSubscription("events")
    const capture: {
      handler: ((ctx: Context, event: BrokerEvent<Native>) => void | PromiseLike<void>) | null
    } = { handler: null }
    let subscribeArguments = 0
    const broker: Broker<void, void, Options, Native> = {
      async publish() {},
      async subscribe(_ctx, _topic, handler) {
        subscribeArguments = arguments.length
        capture.handler = handler
        return subscription
      },
      string() {
        return "controlled"
      }
    }
    let decodes = 0
    const inputs: number[][] = []
    const codec: Codec<Value> = {
      mediaType: "application/json",
      encode(value) {
        return new Uint8Array([value.id])
      },
      decode(bytes) {
        decodes += 1
        inputs.push(Array.from(bytes))
        const id = bytes[0] ?? 0
        bytes[0] = 255
        if (id === 0) throw new Error("schema mismatch")
        return { id }
      }
    }
    const typed = eventBroker(broker, codec)
    const deliveries: EventMessage<Value, Native>[] = []
    expect(
      await typed.subscribe(background(), "events", function receive(_ctx, event) {
        deliveries.push(event)
        expect(decodes).toBe(deliveries.length === 1 ? 0 : 2)
      })
    ).toBe(subscription)
    expect(subscribeArguments).toBe(3)
    const handler = capture.handler
    if (handler === null) throw new Error("handler missing")
    const bytes = new Uint8Array([9])
    await handler(background(), {
      topic: "events",
      message: { headers: { "Content-Type": "application/json" }, body: bytes },
      native
    })
    bytes[0] = 1
    const delivery = deliveries[0]
    if (delivery === undefined) throw new Error("delivery missing")
    expect(delivery.native).toBe(native)
    expect(delivery.decode()).toEqual({ id: 9 })
    expect(delivery.decode()).toEqual({ id: 9 })
    expect(inputs).toEqual([[9], [9]])

    await handler(background(), {
      topic: "events",
      message: { headers: { "content-type": "application/json" }, body: new Uint8Array([0]) },
      native
    })
    const invalid = deliveries[1]
    if (invalid === undefined) throw new Error("invalid delivery missing")
    expect(invalid.native).toBe(native)
    expect(() => invalid.decode()).toThrow("schema mismatch")
    expect(invalid.native).toBe(native)
  })

  test("rejects missing, duplicate, and mismatched media types before codec decode", async () => {
    const deliveries: EventMessage<Value, Native>[] = []
    const capture: {
      receive: ((ctx: Context, event: BrokerEvent<Native>) => void | PromiseLike<void>) | null
    } = { receive: null }
    const broker: Broker<void, void, void, Native> = {
      async publish() {},
      async subscribe(_ctx, _topic, handler) {
        capture.receive = handler
        return nativeSubscription("events")
      },
      string() {
        return "controlled"
      }
    }
    let decodes = 0
    const typed = eventBroker(broker, {
      mediaType: "application/json",
      encode: () => new Uint8Array(),
      decode() {
        decodes += 1
        return { id: 1 }
      }
    })
    await typed.subscribe(background(), "events", (_ctx, event) => {
      deliveries.push(event)
    })
    const receive = capture.receive
    if (receive === null) throw new Error("handler missing")

    for (const headers of [
      {},
      { "content-type": "text/plain" },
      { "Content-Type": "application/json", "content-type": "application/json" }
    ]) {
      await receive(background(), {
        topic: "events",
        message: { headers, body: new Uint8Array([1]) },
        native: { delivery: "native-js-msg" }
      })
    }

    for (const delivery of deliveries) {
      expect(() => delivery.decode()).toThrow("content-type")
    }
    expect(decodes).toBe(0)
  })

  test("omits absent publish options and validates codec, broker, handler, and delivery boundaries", async () => {
    let publishArguments = 0
    let delivery: unknown = null
    const broker: Broker<void, void, void, Native> = {
      async publish() {
        publishArguments = arguments.length
      },
      async subscribe(_ctx, _topic, handler) {
        await handler(background(), delivery as never)
        return nativeSubscription("topic")
      },
      string() {
        return "controlled"
      }
    }
    const codec: Codec<Value> = {
      mediaType: "application/json",
      encode(value) {
        return new Uint8Array([value.id])
      },
      decode(bytes) {
        return { id: bytes[0] ?? 0 }
      }
    }
    const typed = eventBroker(broker, codec)
    await typed.publish(background(), "topic", { id: 1 })
    expect(publishArguments).toBe(3)
    await expect(typed.subscribe(background(), "topic", function receive() {})).rejects.toThrow(
      "broker event"
    )
    delivery = { topic: 7, message: { headers: {}, body: new Uint8Array() }, native: {} }
    await expect(typed.subscribe(background(), "topic", function receive() {})).rejects.toThrow(
      "topic and message"
    )
    delivery = { topic: "topic", message: null, native: {} }
    await expect(typed.subscribe(background(), "topic", function receive() {})).rejects.toThrow(
      "topic and message"
    )
    delivery = {
      topic: "topic",
      message: { headers: null, body: new Uint8Array() },
      native: {}
    }
    await expect(typed.subscribe(background(), "topic", function receive() {})).rejects.toThrow(
      "headers"
    )
    delivery = { topic: "topic", message: { headers: {}, body: [] }, native: {} }
    await expect(typed.subscribe(background(), "topic", function receive() {})).rejects.toThrow(
      "Uint8Array"
    )
    await expect(typed.subscribe(background(), "topic", null as never)).rejects.toThrow("callable")
    expect(() => eventBroker(null as never, codec)).toThrow("object")
    expect(() => eventBroker({} as never, codec)).toThrow("callable")
    expect(() => eventBroker(broker, null as never)).toThrow("codec")
    expect(() => eventBroker(broker, { ...codec, mediaType: "" })).toThrow("mediaType")
    expect(() => eventBroker(broker, { ...codec, encode: true } as never)).toThrow("callable")
    const invalidEncoder = eventBroker(broker, { ...codec, encode: () => null as never })
    await expect(invalidEncoder.publish(background(), "topic", { id: 1 })).rejects.toThrow(
      "Uint8Array"
    )
  })
})
