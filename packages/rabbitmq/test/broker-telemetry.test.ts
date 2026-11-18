import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

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
import type { ChannelModel, RecoveringChannelModel } from "amqplib"

import { newRabbitMqBroker, newRecoveringRabbitMqBroker } from "../src/broker/index"
import { delivery, fakeChannel, fakeConfirmChannel, nextTurn } from "./helpers"

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

/** Feeds the consumer the headers the plug handed to amqplib. */
function replay(channel: ReturnType<typeof fakeChannel>, routingKey = topic): void {
  const call = channel.calls.publish.at(-1)
  const body = call?.[2]
  const properties = call?.[3] as { headers?: Record<string, unknown> } | undefined
  const bytes = body instanceof Uint8Array ? [...body] : []
  channel.onMessage?.(delivery(routingKey, bytes, properties?.headers ?? {}))
}

describe("RabbitMQ broker kit telemetry", () => {
  test("publish and process record names, parentage, and propagation", async () => {
    const channel = fakeChannel()
    const broker = newRabbitMqBroker(channel.native)
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
    replay(channel)
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
    expect(process?.parent?.spanId).toBe(publish?.context.spanId)
    expect(process?.links).toEqual([])
    expect(publish?.attributes[AttributeKey.messagingDestinationName]).toBe(topic)
    expect(publish?.attributes[AttributeKey.messagingSystemName]).toBe("rabbitmq")
    expect(process?.attributes[AttributeKey.messagingSystemName]).toBe("rabbitmq")
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

  test("propagation works without a tracer and a thrown handler is a process failure", async () => {
    const channel = fakeChannel()
    const broker = newRabbitMqBroker(channel.native)
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
    const quiet = await broker.subscribe(plain, topic, (deliveryCtx, event) => {
      extracted = spanFromContext(deliveryCtx).spanContext().traceId
      reinjected = event.message.headers.traceparent ?? ""
    })
    await broker.publish(remote, topic, { headers: {}, body: new Uint8Array([1]) })
    replay(channel)
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
    replay(channel)
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
    const channel = fakeChannel()
    const broker = newRabbitMqBroker(channel.native)
    const recorder = newTelemetryRecorder()
    const [owner, cancel] = withCancel(background())
    const ctx = withTelemetry(owner, recorder.telemetry)
    let entered = false
    const subscriber = await broker.subscribe(ctx, topic, async (deliveryCtx) => {
      entered = true
      const deadline = Date.now() + 1_000
      while (deliveryCtx.err() === null) {
        if (Date.now() > deadline) throw new Error("delivery was not canceled")
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })
      }
    })
    await broker.publish(ctx, topic, { headers: {}, body: new Uint8Array([3]) })
    replay(channel)
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

  test("an empty routing key uses the subscription topic", async () => {
    const channel = fakeChannel()
    const broker = newRabbitMqBroker(channel.native)
    let seen = ""
    const subscriber = await broker.subscribe(background(), "jobs", (_ctx, event) => {
      seen = event.topic
    })
    channel.onMessage?.(delivery("", [1]))
    await until(() => seen.length > 0, "empty routing key was not delivered")
    expect(seen).toBe("jobs")
    await subscriber.unsubscribe(background())
  })

  test("a recovering broker records one publish span and one process span", async () => {
    const channel = fakeConfirmChannel()
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const provider = await newRecoveringRabbitMqBroker(background(), async (setup) => {
      await setup({
        createConfirmChannel: async () => channel.native
      } as ChannelModel)
      return recovering
    })
    const recorder = newTelemetryRecorder()
    const ctx = withTelemetry(background(), recorder.telemetry)
    const subscriber = await provider.broker.subscribe(ctx, topic, () => {})
    const publishing = provider.broker.publish(ctx, topic, {
      headers: { source: "api" },
      body: new Uint8Array([5])
    })
    channel.confirm(0)
    await publishing
    replay(channel)
    await nextTurn()
    await until(
      () => recorder.spans().some((span) => span.name === `process ${topic}` && span.ended),
      "recovering process span did not end"
    )
    expect(recorder.spans().filter((span) => span.name === "publish")).toHaveLength(1)
    expect(recorder.spans().filter((span) => span.name === `process ${topic}`)).toHaveLength(1)
    expect(recorder.spans()[0]?.attributes[AttributeKey.messagingSystemName]).toBe("rabbitmq")
    await subscriber.unsubscribe(background())
  })
})
