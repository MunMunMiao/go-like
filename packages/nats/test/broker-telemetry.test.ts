import { describe, expect, test } from "bun:test"

import { subscriberTerminal } from "@go-like/core/broker/provider"
import { background, withCancel } from "@go-like/core/context"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  newTelemetry,
  withTelemetry
} from "@go-like/core/telemetry"
import { withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import { newTelemetryRecorder } from "@go-like/core/testing"
import { spanFromContext } from "@go-like/core/trace"
import type { JetStreamClient, PubAck } from "@nats-io/jetstream"
import {
  headers,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
  type PublishOptions
} from "@nats-io/transport-node"

import { newNatsCoreBroker } from "../src/broker"
import { newNatsJetStreamBroker } from "../src/jetstream"
import { FakeConsumerMessages, FakeSubscription, jetStreamMessage } from "./broker-helpers"

const topic = "orders"

/** Waits until `predicate` holds. */
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

/** Builds one core message from the headers the plug handed to NATS. */
function delivered(subject: string, body: Uint8Array, nativeHeaders: MsgHdrs | undefined): Msg {
  const data = new Uint8Array(body)
  const message = {
    subject,
    sid: 1,
    data,
    respond: () => false,
    json: <T>() => JSON.parse(new TextDecoder().decode(data)) as T,
    string: () => new TextDecoder().decode(data)
  }
  if (nativeHeaders === undefined) return message
  return { ...message, headers: nativeHeaders }
}

describe("NATS broker kit telemetry", () => {
  test("core publish and process record names, parentage, and propagation", async () => {
    const subscriptions = new Map<string, FakeSubscription[]>()
    const connection = {
      publish(subject: string, body: Uint8Array, options?: PublishOptions) {
        const message = delivered(subject, body, options?.headers)
        for (const subscription of subscriptions.get(subject) ?? []) subscription.push(message)
      },
      subscribe(subject: string) {
        const subscription = new FakeSubscription()
        const current = subscriptions.get(subject) ?? []
        current.push(subscription)
        subscriptions.set(subject, current)
        return subscription
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const recorder = newTelemetryRecorder()
    const ctx = withTelemetry(background(), recorder.telemetry)
    const caller = Object.freeze({
      TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      source: "api"
    })
    let traceparent = ""
    const subscriber = await broker.subscribe(ctx, topic, (_delivery, event) => {
      traceparent = event.message.headers.traceparent ?? ""
      expect(event.message.headers.source).toBe("api")
      expect(event.message.headers.TraceParent).toBeUndefined()
      expect(Object.isFrozen(event.message.headers)).toBe(true)
    })
    await broker.publish(ctx, topic, { headers: caller, body: new Uint8Array([4]) })
    await until(
      () => recorder.spans().some((span) => span.name === `process ${topic}` && span.ended),
      "process span did not end"
    )
    expect(caller.TraceParent.startsWith("00-aaaaaaaa")).toBe(true)
    const publish = recorder.spans().find((span) => span.name === "publish")
    const process = recorder.spans().find((span) => span.name === `process ${topic}`)
    expect(publish?.kind).toBe("producer")
    expect(publish?.root).toBe(false)
    expect(process?.kind).toBe("consumer")
    expect(process?.root).toBe(false)
    expect(process?.parent?.spanId).toBe(publish?.context.spanId)
    expect(process?.links).toEqual([])
    expect(publish?.links).toEqual([])
    expect(publish?.attributes[AttributeKey.messagingDestinationName]).toBe(topic)
    expect(publish?.attributes[AttributeKey.messagingSystemName]).toBe("nats")
    expect(process?.attributes[AttributeKey.messagingSystemName]).toBe("nats")
    expect(process?.status).toBe("unset")
    expect(traceparent.includes(publish?.context.traceId ?? "missing")).toBe(true)
    expect(
      recorder
        .measurements()
        .some((item) => item.descriptor.name === MetricName.messagingClientOperationDuration)
    ).toBe(true)
    expect(
      recorder
        .measurements()
        .some((item) => item.descriptor.name === MetricName.messagingProcessDuration)
    ).toBe(true)
    expect(
      recorder.logs().find((item) => item.record.event === LogEvent.messagingPublishCompleted)
        ?.record.level
    ).toBe("debug")
    expect(
      recorder.logs().find((item) => item.record.event === LogEvent.messagingProcessCompleted)
        ?.record.level
    ).toBe("info")
    expect(publish?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeSuccess)
    await subscriber.unsubscribe(background())
  })

  test("core propagation works without a tracer and a thrown handler is a process failure", async () => {
    const subscriptions = new Map<string, FakeSubscription[]>()
    const connection = {
      publish(subject: string, body: Uint8Array, options?: PublishOptions) {
        const message = delivered(subject, body, options?.headers)
        for (const subscription of subscriptions.get(subject) ?? []) subscription.push(message)
      },
      subscribe(subject: string) {
        const subscription = new FakeSubscription()
        const current = subscriptions.get(subject) ?? []
        current.push(subscription)
        subscriptions.set(subject, current)
        return subscription
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const plain = withTelemetry(background(), newTelemetry({}))
    const remote = withRemoteSpanContext(plain, {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
      traceState: "",
      isRemote: true
    })
    let extracted = ""
    let reinjected = ""
    const quiet = await broker.subscribe(plain, topic, (delivery, event) => {
      extracted = spanFromContext(delivery).spanContext().traceId
      reinjected = event.message.headers.traceparent ?? ""
    })
    await broker.publish(remote, topic, { headers: {}, body: new Uint8Array([1]) })
    await until(() => extracted.length > 0, "upstream parent was not extracted")
    expect(extracted).toBe("0123456789abcdef0123456789abcdef")
    expect(reinjected.includes("0123456789abcdef0123456789abcdef")).toBe(true)
    await quiet.unsubscribe(background())

    const recorder = newTelemetryRecorder()
    const ctx = withTelemetry(background(), recorder.telemetry)
    const failure = new Error("handler-secret-text")
    failure.name = "Boom"
    const failing = await broker.subscribe(ctx, topic, () => {
      throw failure
    })
    await broker.publish(ctx, topic, { headers: {}, body: new Uint8Array([2]) })
    await expect(subscriberTerminal(failing)).rejects.toBe(failure)
    const process = recorder.spans().find((span) => span.name === `process ${topic}`)
    expect(process?.status).toBe("error")
    expect(process?.attributes[AttributeKey.errorType]).toBe("Boom")
    expect(process?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeFailure)
    const logged = recorder
      .logs()
      .find((item) => item.record.event === LogEvent.messagingProcessCompleted)
    expect(logged?.record.level).toBe("error")
    expect(logged?.record.message.includes("handler-secret-text")).toBe(false)
  })

  test("canceling the subscription ends the process unit as canceled", async () => {
    const subscriptions = new Map<string, FakeSubscription[]>()
    const connection = {
      publish(subject: string, body: Uint8Array, options?: PublishOptions) {
        for (const subscription of subscriptions.get(subject) ?? []) {
          subscription.push(delivered(subject, body, options?.headers))
        }
      },
      subscribe(subject: string) {
        const subscription = new FakeSubscription()
        const current = subscriptions.get(subject) ?? []
        current.push(subscription)
        subscriptions.set(subject, current)
        return subscription
      }
    } as unknown as NatsConnection
    const broker = newNatsCoreBroker(connection)
    const recorder = newTelemetryRecorder()
    const [owner, cancel] = withCancel(background())
    const ctx = withTelemetry(owner, recorder.telemetry)
    let entered = false
    const subscriber = await broker.subscribe(ctx, topic, async (delivery) => {
      entered = true
      const deadline = Date.now() + 1_000
      while (delivery.err() === null) {
        if (Date.now() > deadline) throw new Error("delivery was not canceled")
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })
      }
    })
    await broker.publish(ctx, topic, { headers: {}, body: new Uint8Array([3]) })
    await until(() => entered, "handler did not start")
    cancel()
    await until(
      () =>
        recorder.spans().some((span) => {
          return (
            span.name === `process ${topic}` &&
            span.ended &&
            span.attributes[AttributeKey.outcome] === "canceled"
          )
        }),
      "canceled process span missing"
    )
    const process = recorder.spans().find((span) => span.name === `process ${topic}`)
    expect(process?.status).toBe("unset")
    expect(process?.attributes[AttributeKey.errorType]).toBe("canceled")
    expect(
      recorder.logs().find((item) => item.record.event === LogEvent.messagingProcessCompleted)
        ?.record.level
    ).toBe("info")
    await subscriber.unsubscribe(background())
  })

  test("jetstream publish and process share one trace", async () => {
    const messages = new FakeConsumerMessages()
    const ack = Object.freeze({ stream: "EVENTS", seq: 1, duplicate: false }) satisfies PubAck
    const client = {
      publish(subject: string, body: Uint8Array, options?: { headers?: MsgHdrs }) {
        const settlement = { ack: 0, nak: 0, term: 0 }
        const native = jetStreamMessage(subject, [], settlement)
        messages.push({
          ...native,
          subject,
          data: new Uint8Array(body),
          headers: options?.headers ?? headers()
        })
        return Promise.resolve(ack)
      }
    } as unknown as JetStreamClient
    const broker = newNatsJetStreamBroker(client, () => messages)
    const recorder = newTelemetryRecorder()
    const ctx = withTelemetry(background(), recorder.telemetry)
    await broker.subscribe(ctx, topic, () => {})
    const published = await broker.publish(ctx, topic, {
      headers: { source: "api" },
      body: new Uint8Array([5])
    })
    expect(published).toBe(ack)
    await until(
      () => recorder.spans().some((span) => span.name === `process ${topic}` && span.ended),
      "jetstream process span did not end"
    )
    const publish = recorder.spans().find((span) => span.name === "publish")
    const process = recorder.spans().find((span) => span.name === `process ${topic}`)
    expect(publish?.attributes[AttributeKey.messagingSystemName]).toBe("nats")
    expect(process?.parent?.spanId).toBe(publish?.context.spanId)
    expect(process?.attributes[AttributeKey.messagingSystemName]).toBe("nats")
    expect(broker.string()).toBe("nats-jetstream")
  })
})
