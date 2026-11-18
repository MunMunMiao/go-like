/**
 * Telemetry base.
 * Shared value types, the provider bundle, and the semantic-convention constants.
 * Socket plugs attach through `lifecycle`. Applications pass the bundle to `newApp(telemetry(tel))`.
 */
export type {
  AttributeValue,
  Attributes,
  CompletionLogMode,
  Scope,
  Telemetry,
  TelemetryAlreadyStartedError,
  TelemetryLifecycle,
  TelemetryOptions
} from "./types"

export { newTelemetry, withTelemetry } from "./bundle"

export {
  AttributeKey,
  LogEvent,
  LogField,
  MetricName,
  SemconvValue,
  SemconvVersion,
  SpanEvent
} from "./semconv"
