import { describe, expect, test } from "bun:test"

import type { BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import { background, type Context } from "@likego/context"
import type { NatsJetStreamBrokerPublishOptions } from "@likego/nats/jetstream/broker"
import type { JsMsg, PubAck } from "@nats-io/jetstream"

import { deadLetterTelemetrySubject, rawTelemetrySubjects, type TelemetryBroker } from "../src/nats"
import { processTelemetry } from "../src/processor"
import { TelemetryValidationError, decodeRawTelemetry, newTelemetryPolicy } from "../src/telemetry"
import { newTelemetryServer } from "../src/worker"

const encoder = new TextEncoder()
const now = new Date("2026-07-23T08:16:00.000Z")
const validRaw = Object.freeze({
  schemaVersion: 1,
  messageId: "msg_0189",
  deviceId: "sensor_42",
  sequence: "1042",
  observedAt: "2026-07-23T08:15:30.000Z",
  temperatureC: 23.4,
  humidityPct: 58.2
})
const pubAck: PubAck = Object.freeze({
  stream: "TELEMETRY_VALIDATED",
  seq: 1,
  duplicate: false
})

interface PublishedMessage {
  readonly topic: string
  readonly message: BrokerMessage
  readonly options: NatsJetStreamBrokerPublishOptions | undefined
}

interface NativeState {
  readonly actions: string[]
  readonly native: JsMsg
}

function nativeMessage(deliveryCount = 1, ackConfirmed = true): NativeState {
  const actions: string[] = []
  const native = {
    info: { deliveryCount, streamSequence: 71 },
    async ackAck(): Promise<boolean> {
      actions.push("ack")
      return ackConfirmed
    },
    nak(delay?: number): void {
      actions.push(`nak:${delay ?? 0}`)
    },
    term(reason?: string): void {
      actions.push(`term:${reason ?? ""}`)
    }
  } as unknown as JsMsg
  return { actions, native }
}

function rawEvent(
  state: NativeState,
  value: unknown = validRaw,
  body = encoder.encode(JSON.stringify(value)),
  topic = "telemetry.raw.v1.sensor_42"
): BrokerEvent<JsMsg> {
  return Object.freeze({
    topic,
    message: Object.freeze({ headers: Object.freeze({}), body }),
    native: state.native
  })
}

function recordingBroker(
  actions: string[],
  published: PublishedMessage[],
  failure: Error | null = null
): TelemetryBroker {
  return Object.freeze({
    async publish(
      _ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: NatsJetStreamBrokerPublishOptions
    ): Promise<PubAck> {
      actions.push(`publish:${topic}`)
      published.push({ topic, message, options })
      if (failure !== null) throw failure
      return pubAck
    },
    async subscribe(): Promise<Subscriber> {
      throw new Error("unused subscribe")
    },
    string(): string {
      return "test-telemetry"
    }
  })
}

describe("telemetry decode boundary", () => {
  test("rejects missing required keys instead of inventing defaults", () => {
    const missing = { ...validRaw }
    Reflect.deleteProperty(missing, "temperatureC")

    expect(() =>
      decodeRawTelemetry(
        encoder.encode(JSON.stringify(missing)),
        newTelemetryPolicy(),
        now.getTime()
      )
    ).toThrow(new TelemetryValidationError("MISSING_REQUIRED_KEY"))
  })

  test("drops unknown fields and accepts configured range boundaries", () => {
    const decoded = decodeRawTelemetry(
      encoder.encode(JSON.stringify({ ...validRaw, temperatureC: -40, ignored: "drop" })),
      newTelemetryPolicy({ minimumTemperatureC: -40, maximumTemperatureC: 80 }),
      now.getTime()
    )

    expect(decoded.temperatureC).toBe(-40)
    expect("ignored" in decoded).toBe(false)
    expect(Object.isFrozen(decoded)).toBe(true)
  })

  test.each([
    [new Uint8Array([0xff]), "INVALID_UTF8"],
    [encoder.encode("{"), "INVALID_JSON"],
    [encoder.encode("[]"), "INVALID_SHAPE"],
    [encoder.encode(JSON.stringify({ ...validRaw, schemaVersion: 2 })), "INVALID_SHAPE"],
    [encoder.encode(JSON.stringify({ ...validRaw, deviceId: "bad.token" })), "INVALID_IDENTIFIER"],
    [encoder.encode(JSON.stringify({ ...validRaw, sequence: "01" })), "INVALID_SEQUENCE"],
    [
      encoder.encode(JSON.stringify({ ...validRaw, sequence: "18446744073709551616" })),
      "INVALID_SEQUENCE"
    ],
    [
      encoder.encode(JSON.stringify({ ...validRaw, observedAt: "not-a-date" })),
      "INVALID_TIMESTAMP"
    ],
    [
      encoder.encode(JSON.stringify({ ...validRaw, observedAt: "2026-07-23T08:18:00.000Z" })),
      "FUTURE_TIMESTAMP"
    ],
    [
      encoder.encode(JSON.stringify({ ...validRaw, temperatureC: 101 })),
      "TEMPERATURE_OUT_OF_RANGE"
    ],
    [encoder.encode(JSON.stringify({ ...validRaw, humidityPct: 101 })), "HUMIDITY_OUT_OF_RANGE"]
  ])("returns a stable permanent error for invalid bytes %#", (body, code) => {
    expect(() => decodeRawTelemetry(body, newTelemetryPolicy(), now.getTime())).toThrow(
      new TelemetryValidationError(code as never)
    )
  })

  test.each([
    [{ minimumTemperatureC: 2, maximumTemperatureC: 1 }, "temperature range is invalid"],
    [{ maximumFutureSkewMs: -1 }, "maximumFutureSkewMs must be a non-negative integer"],
    [{ retryDelayMs: 1.5 }, "retryDelayMs must be a non-negative integer"],
    [{ maximumDeliveries: 0 }, "maximumDeliveries must be a positive integer"]
  ])("rejects an invalid operator policy %#", (input, message) => {
    expect(() => newTelemetryPolicy(input)).toThrow(message)
  })
})

describe("telemetry settlement", () => {
  test("publishes validated bytes before confirming the raw delivery", async () => {
    const state = nativeMessage()
    const published: PublishedMessage[] = []
    const broker = recordingBroker(state.actions, published)

    const result = await processTelemetry(
      background(),
      broker,
      rawEvent(state),
      newTelemetryPolicy(),
      () => now
    )

    expect(result).toEqual({
      kind: "validated",
      eventId: "sensor_42/msg_0189",
      acknowledgement: pubAck,
      ackConfirmed: true
    })
    expect(state.actions).toEqual(["publish:telemetry.validated.v1.sensor_42", "ack"])
    expect(published[0]?.options).toEqual({ msgID: "sensor_42/msg_0189", timeout: 500 })
    expect(JSON.parse(new TextDecoder().decode(published[0]?.message.body))).toMatchObject({
      eventId: "sensor_42/msg_0189",
      validatedAt: now.toISOString(),
      sourceStreamSequence: "71"
    })
  })

  test("publishes invalid raw bytes to DLQ before term", async () => {
    const state = nativeMessage()
    const published: PublishedMessage[] = []
    const broker = recordingBroker(state.actions, published)
    const body = encoder.encode('{"schemaVersion":1}')

    const result = await processTelemetry(
      background(),
      broker,
      rawEvent(state, null, body),
      newTelemetryPolicy(),
      () => now
    )

    expect(result.kind).toBe("dead-lettered")
    expect(state.actions).toEqual([
      `publish:${deadLetterTelemetrySubject}`,
      "term:MISSING_REQUIRED_KEY"
    ])
    expect(published[0]?.message.body).toEqual(body)
    expect(published[0]?.message.headers).toEqual({
      "content-type": "application/octet-stream",
      "x-telemetry-error": "MISSING_REQUIRED_KEY",
      "x-source-subject": "telemetry.raw.v1.sensor_42",
      "x-source-stream-sequence": "71",
      "x-source-delivery-count": "1"
    })
  })

  test("dead-letters a payload whose device does not match its trusted subject", async () => {
    const state = nativeMessage()
    const published: PublishedMessage[] = []

    const result = await processTelemetry(
      background(),
      recordingBroker(state.actions, published),
      rawEvent(
        state,
        validRaw,
        encoder.encode(JSON.stringify(validRaw)),
        "telemetry.raw.v1.sensor_other"
      ),
      newTelemetryPolicy(),
      () => now
    )

    expect(result).toMatchObject({
      kind: "dead-lettered",
      errorCode: "SUBJECT_DEVICE_MISMATCH"
    })
    expect(state.actions).toEqual([
      `publish:${deadLetterTelemetrySubject}`,
      "term:SUBJECT_DEVICE_MISMATCH"
    ])
    expect(published).toHaveLength(1)
  })

  test("naks transient validated and DLQ publish failures", async () => {
    const validatedState = nativeMessage()
    const failure = new Error("service unavailable")
    const validatedResult = await processTelemetry(
      background(),
      recordingBroker(validatedState.actions, [], failure),
      rawEvent(validatedState),
      newTelemetryPolicy({ retryDelayMs: 25 }),
      () => now
    )
    expect(validatedResult).toEqual({ kind: "retry", errorCode: "VALIDATED_PUBLISH_FAILED" })
    expect(validatedState.actions.at(-1)).toBe("nak:25")

    const dlqState = nativeMessage()
    const dlqResult = await processTelemetry(
      background(),
      recordingBroker(dlqState.actions, [], failure),
      rawEvent(dlqState, null, encoder.encode("{")),
      newTelemetryPolicy({ retryDelayMs: 25 }),
      () => now
    )
    expect(dlqResult).toEqual({ kind: "retry", errorCode: "DLQ_PUBLISH_FAILED" })
    expect(dlqState.actions.at(-1)).toBe("nak:25")
  })

  test("naks an unconfirmed ack and dead-letters the delivery threshold", async () => {
    const unconfirmed = nativeMessage(1, false)
    const retry = await processTelemetry(
      background(),
      recordingBroker(unconfirmed.actions, []),
      rawEvent(unconfirmed),
      newTelemetryPolicy(),
      () => now
    )
    expect(retry).toEqual({ kind: "retry", errorCode: "ACK_UNCONFIRMED" })
    expect(unconfirmed.actions.at(-1)).toBe("nak:100")

    const exhausted = nativeMessage(5)
    const published: PublishedMessage[] = []
    const result = await processTelemetry(
      background(),
      recordingBroker(exhausted.actions, published),
      rawEvent(exhausted),
      newTelemetryPolicy({ maximumDeliveries: 5 }),
      () => now
    )
    expect(result.kind).toBe("dead-lettered")
    expect(published[0]?.message.headers["x-telemetry-error"]).toBe("RETRY_LIMIT")
    expect(exhausted.actions.at(-1)).toBe("term:RETRY_LIMIT")
  })

  test("adapts exactly one durable consumer into a Core server", async () => {
    let subscribedTopic = ""
    const subscriptionCapture: {
      handler: ((ctx: Context, event: BrokerEvent<JsMsg>) => void | PromiseLike<void>) | null
    } = { handler: null }
    let stopCount = 0
    const accepted: Subscriber = Object.freeze({
      topic: rawTelemetrySubjects,
      async unsubscribe(): Promise<void> {
        stopCount += 1
      }
    })
    const broker: TelemetryBroker = Object.freeze({
      async publish(): Promise<PubAck> {
        return pubAck
      },
      async subscribe(
        _ctx: Context,
        topic: string,
        handler: (ctx: Context, event: BrokerEvent<JsMsg>) => void | PromiseLike<void>
      ): Promise<Subscriber> {
        subscribedTopic = topic
        subscriptionCapture.handler = handler
        return accepted
      },
      string(): string {
        return "test-telemetry"
      }
    })

    const worker = newTelemetryServer(broker)
    const running = worker.start(background())
    await Promise.resolve()
    const subscribedHandler = subscriptionCapture.handler
    if (subscribedHandler === null) throw new Error("telemetry handler was not subscribed")
    const state = nativeMessage()
    await subscribedHandler(
      background(),
      rawEvent(state, { ...validRaw, observedAt: "2020-01-01T00:00:00.000Z" })
    )
    await worker.stop(background())
    await running

    expect(subscribedTopic).toBe(rawTelemetrySubjects)
    expect(state.actions).toEqual(["ack"])
    expect(stopCount).toBe(1)
  })
})
