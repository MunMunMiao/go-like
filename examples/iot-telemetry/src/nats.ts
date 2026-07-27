import type { Broker } from "@likego/broker"
import type { NatsJetStreamBrokerPublishOptions } from "@likego/nats/jetstream/broker"
import type { JsMsg, PubAck } from "@nats-io/jetstream"

export const rawTelemetrySubjectPrefix = "telemetry.raw.v1"
export const rawTelemetrySubjects = `${rawTelemetrySubjectPrefix}.*`
export const validatedTelemetrySubjectPrefix = "telemetry.validated.v1"
export const deadLetterTelemetrySubject = "telemetry.dlq.v1"

export type TelemetryBroker = Broker<NatsJetStreamBrokerPublishOptions, PubAck, void, JsMsg>
