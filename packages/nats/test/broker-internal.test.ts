import { describe, expect, test } from "bun:test"

import type { BrokerEvent } from "@likego/broker"
import { registerSubscriberTerminal, subscriberTerminal } from "@likego/broker/provider"
import { background } from "@likego/context"
import { headers } from "@nats-io/transport-node"
import {
  brokerEvent,
  prepareBrokerMessage,
  validateTopic,
  type NativeNatsMessage
} from "../src/broker-message"
import {
  managedSubscriber,
  rejectNativeBrokerAdmission,
  type NativeBrokerLifecycle
} from "../src/broker-runtime"
import { nextTurn } from "./broker-helpers"

function event(value: string): BrokerEvent<string> {
  return {
    topic: "events",
    message: { headers: {}, body: new Uint8Array() },
    native: value
  }
}

async function* one(): AsyncGenerator<string> {
  yield "native"
}

async function* empty(): AsyncGenerator<string> {}

describe("NATS Broker internal boundaries", () => {
  test("validates complete Unicode, message, header, and native delivery boundaries", () => {
    expect(() => validateTopic("\ud83d\ude80.events")).not.toThrow()
    expect(() => validateTopic("\ud800x")).toThrow("well-formed")
    expect(() => validateTopic("\udc00")).toThrow("well-formed")
    expect(() => prepareBrokerMessage(null as never)).toThrow("object")
    expect(() =>
      prepareBrokerMessage({ headers: { "": "value" }, body: new Uint8Array() })
    ).toThrow("well-formed")
    expect(() =>
      prepareBrokerMessage({ headers: { "\ud800x": "value" }, body: new Uint8Array() })
    ).toThrow("well-formed")
    expect(() =>
      prepareBrokerMessage({ headers: { valid: 7 as never }, body: new Uint8Array() })
    ).toThrow("well-formed")
    expect(() => brokerEvent(null as never)).toThrow("delivery")
    expect(() => brokerEvent({ subject: "events", data: [] as never, headers: undefined })).toThrow(
      "Uint8Array"
    )

    const native: NativeNatsMessage = {
      subject: "events",
      data: new Uint8Array([1])
    }
    const converted = brokerEvent(native)
    expect(converted.native).toBe(native)
    expect(converted.message.headers).toEqual({})

    const nativeHeaders = headers()
    nativeHeaders.set("__proto__", "sentinel")
    const special = brokerEvent({
      subject: "events",
      data: new Uint8Array(),
      headers: nativeHeaders
    })
    expect(Object.getOwnPropertyDescriptor(special.message.headers, "__proto__")?.value).toBe(
      "sentinel"
    )
  })

  test("rejects an invalid lifecycle runtime before starting delivery", () => {
    expect(() =>
      managedSubscriber(background(), "events", empty(), {} as never, event, () => {})
    ).toThrow("runtime")
    expect(() => registerSubscriberTerminal(null as never, Promise.resolve())).toThrow("object")
    expect(() =>
      registerSubscriberTerminal({ topic: "events", unsubscribe: async () => {} }, null as never)
    ).toThrow("PromiseLike")
  })

  test("normalizes a synchronous unsubscribe throw", async () => {
    const runtime = {
      running: Promise.resolve(),
      unsubscribe() {
        throw "unsubscribe failed"
      }
    }
    const managed = managedSubscriber(background(), "events", empty(), runtime, event, () => {})

    await expect(managed.unsubscribe(background())).rejects.toMatchObject({
      message: "NATS Broker unsubscribe rejected with a non-Error value",
      cause: "unsubscribe failed"
    })
  })

  test("associates delivery completion without expanding Subscriber", async () => {
    const failure = new Error("handler failed")
    const runtime = {
      running: Promise.resolve(),
      unsubscribe: async () => {}
    }
    const managed = managedSubscriber(background(), "events", one(), runtime, event, () => {
      throw failure
    })
    const terminal = subscriberTerminal(managed)

    expect(Object.keys(managed)).toEqual(["topic", "unsubscribe"])
    expect(terminal).not.toBeNull()
    await expect(terminal).rejects.toBe(failure)
  })

  test("aggregates distinct unsubscribe and delivery failures", async () => {
    const nativeFailure = new Error("native failed")
    const handlerFailure = new Error("handler failed")
    const runtime = {
      running: Promise.resolve(),
      unsubscribe: async () => {
        throw nativeFailure
      }
    }
    const managed = managedSubscriber(background(), "events", one(), runtime, event, () => {
      throw handlerFailure
    })
    await nextTurn()
    const failure = await managed.unsubscribe(background()).catch((value: unknown) => value)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).cause).toBe(handlerFailure)
    expect((failure as AggregateError).errors).toEqual([handlerFailure, nativeFailure])
  })

  test("aggregates a non-Error handler rejection with a synchronous unsubscribe failure", async () => {
    const stopFailure = new Error("stop failed")
    const runtime = {
      running: Promise.resolve(),
      unsubscribe() {
        throw stopFailure
      }
    }
    const managed = managedSubscriber(background(), "events", one(), runtime, event, () => {
      throw "handler failed"
    })
    await nextTurn()
    const failure = await managed.unsubscribe(background()).catch((value: unknown) => value)

    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors[0]).toMatchObject({
      message: "NATS Broker handler rejected with a non-Error value",
      cause: "handler failed"
    })
    expect(errors[1]).toBe(stopFailure)
  })

  test("bounds a provisional native rollback at the provider boundary", async () => {
    const originalSetTimeout = globalThis.setTimeout
    let timeoutCallback: (() => void) | null = null
    globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      const timer = originalSetTimeout(handler, timeout, ...arguments_)
      if (timeout === 25_000 && typeof handler === "function") {
        timeoutCallback = () => {
          handler(...arguments_)
        }
      }
      return timer
    }) as typeof setTimeout
    try {
      let forceCalls = 0
      const lifecycle: NativeBrokerLifecycle = {
        kind: "core",
        graceful: async () => {},
        terminal: () => new Promise<void>(() => {}),
        force() {
          forceCalls += 1
        }
      }
      const primary = new Error("admission canceled")
      const rejecting = rejectNativeBrokerAdmission(lifecycle, primary).catch(
        (value: unknown) => value
      )
      expect(timeoutCallback).not.toBeNull()
      const invokeTimeout = timeoutCallback as (() => void) | null
      invokeTimeout?.()

      const failure = await rejecting
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).cause).toBe(primary)
      expect((failure as AggregateError).errors[0]).toBe(primary)
      expect((failure as AggregateError).errors[1]).toMatchObject({
        code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT",
        forced: true
      })
      expect(forceCalls).toBe(1)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
