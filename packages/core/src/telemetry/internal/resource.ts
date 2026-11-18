import type { Attributes } from "../types"
import { AttributeKey } from "../semconv"

const healthResponses = new WeakSet<Response>()
const telemetryValues = new WeakSet<object>()

/** Identity accessor set core turns into `service.*` resource attributes. Empty strings are omitted. */
export interface ResourceIdentity {
  id(): string
  name(): string
  version(): string
}

/** Builds the resource attributes installed on an App Context. */
export function resourceFromAppInfo(info: ResourceIdentity): Attributes {
  const attributes: Record<string, string> = {}
  const name = info.name()
  const version = info.version()
  const id = info.id()
  if (name !== "") attributes[AttributeKey.serviceName] = name
  if (version !== "") attributes[AttributeKey.serviceVersion] = version
  if (id !== "") attributes[AttributeKey.serviceInstanceId] = id
  return Object.freeze(attributes)
}

/** Records a bundle created by `newTelemetry`. */
export function markTelemetry(value: object): void {
  telemetryValues.add(value)
}

/** Reports whether `value` is a bundle created by this core copy. */
export function isTelemetry(value: unknown): boolean {
  return typeof value === "object" && value !== null && telemetryValues.has(value)
}

/** Marks a response produced by the core health handler so its completion log is suppressed. */
export function markHealthResponse(response: Response): Response {
  healthResponses.add(response)
  return response
}

/** Reports whether `markHealthResponse` has seen this response object. */
export function isHealthResponse(response: Response): boolean {
  return healthResponses.has(response)
}
