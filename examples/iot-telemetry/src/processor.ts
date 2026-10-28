import type { BrokerEvent, BrokerMessage } from "@go-like/broker"
import type { Context } from "@go-like/context"
import type { JsMsg, PubAck } from "@nats-io/jetstream"

import {
  TelemetryValidationError,
  decodeRawTelemetry,
  defaultTelemetryPolicy,
  encodeValidatedTelemetry,
  telemetryMediaType,
  type RawTelemetry,
  type TelemetryErrorCode,
  type TelemetryPolicy,
  type ValidatedTelemetry
} from "./telemetry"
import {
  deadLetterTelemetrySubject,
  rawTelemetrySubjectPrefix,
  validatedTelemetrySubjectPrefix,
  type TelemetryBroker
} from "./nats"

export type TelemetryProcessResult =
  | {
      readonly kind: "validated"
      readonly eventId: string
      readonly acknowledgement: PubAck
      readonly ackConfirmed: true
    }
  | {
      readonly kind: "dead-lettered"
      readonly errorCode: TelemetryErrorCode
      readonly acknowledgement: PubAck
    }
  | {
      readonly kind: "retry"
      readonly errorCode: "ACK_UNCONFIRMED" | "DLQ_PUBLISH_FAILED" | "VALIDATED_PUBLISH_FAILED"
    }

/** Publishes one permanent failure before terminating its original delivery. */
async function deadLetter(
  ctx: Context,
  broker: TelemetryBroker,
  event: BrokerEvent<JsMsg>,
  policy: TelemetryPolicy,
  errorCode: TelemetryErrorCode
): Promise<TelemetryProcessResult> {
  const native = event.native
  let acknowledgement: PubAck
  try {
    acknowledgement = await broker.publish(
      ctx,
      deadLetterTelemetrySubject,
      Object.freeze({
        headers: Object.freeze({
          "content-type": "application/octet-stream",
          "x-telemetry-error": errorCode,
          "x-source-subject": event.topic,
          "x-source-stream-sequence": String(native.info.streamSequence),
          "x-source-delivery-count": String(native.info.deliveryCount)
        }),
        body: new Uint8Array(event.message.body)
      }),
      { msgID: `dlq:${native.info.streamSequence}`, timeout: 500 }
    )
  } catch {
    native.nak(policy.retryDelayMs)
    return Object.freeze({ kind: "retry", errorCode: "DLQ_PUBLISH_FAILED" })
  }
  native.term(errorCode)
  return Object.freeze({ kind: "dead-lettered", errorCode, acknowledgement })
}

/** Processes and explicitly settles one native JetStream delivery. */
export async function processTelemetry(
  ctx: Context,
  broker: TelemetryBroker,
  event: BrokerEvent<JsMsg>,
  policy: TelemetryPolicy = defaultTelemetryPolicy,
  now: () => Date = () => new Date()
): Promise<TelemetryProcessResult> {
  if (event.native.info.deliveryCount >= policy.maximumDeliveries) {
    return await deadLetter(ctx, broker, event, policy, "RETRY_LIMIT")
  }

  let raw: RawTelemetry
  const validationTime = now()
  try {
    raw = decodeRawTelemetry(event.message.body, policy, validationTime.getTime())
  } catch (error) {
    if (!(error instanceof TelemetryValidationError)) throw error
    return await deadLetter(ctx, broker, event, policy, error.code)
  }
  if (event.topic !== `${rawTelemetrySubjectPrefix}.${raw.deviceId}`) {
    return await deadLetter(ctx, broker, event, policy, "SUBJECT_DEVICE_MISMATCH")
  }

  const eventId = `${raw.deviceId}/${raw.messageId}`
  const validated: ValidatedTelemetry = {
    schemaVersion: 1,
    eventId,
    messageId: raw.messageId,
    deviceId: raw.deviceId,
    sequence: raw.sequence,
    observedAt: raw.observedAt,
    temperatureC: raw.temperatureC,
    ...(raw.humidityPct === undefined ? {} : { humidityPct: raw.humidityPct }),
    validatedAt: validationTime.toISOString(),
    sourceStreamSequence: String(event.native.info.streamSequence)
  }
  const message: BrokerMessage = Object.freeze({
    headers: Object.freeze({ "content-type": telemetryMediaType }),
    body: encodeValidatedTelemetry(validated)
  })
  let acknowledgement: PubAck
  try {
    acknowledgement = await broker.publish(
      ctx,
      `${validatedTelemetrySubjectPrefix}.${raw.deviceId}`,
      message,
      { msgID: eventId, timeout: 500 }
    )
  } catch {
    event.native.nak(policy.retryDelayMs)
    return Object.freeze({ kind: "retry", errorCode: "VALIDATED_PUBLISH_FAILED" })
  }
  if (!(await event.native.ackAck({ timeout: 500 }))) {
    event.native.nak(policy.retryDelayMs)
    return Object.freeze({ kind: "retry", errorCode: "ACK_UNCONFIRMED" })
  }
  return Object.freeze({ kind: "validated", eventId, acknowledgement, ackConfirmed: true })
}
