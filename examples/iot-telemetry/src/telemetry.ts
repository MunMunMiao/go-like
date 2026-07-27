const requiredRawKeys = [
  "schemaVersion",
  "messageId",
  "deviceId",
  "sequence",
  "observedAt",
  "temperatureC"
] as const
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const sequencePattern = /^(?:0|[1-9][0-9]{0,19})$/u
const maximumUnsignedBigInt = 18_446_744_073_709_551_615n
const fatalDecoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

export interface RawTelemetry {
  readonly schemaVersion: 1
  readonly messageId: string
  readonly deviceId: string
  readonly sequence: string
  readonly observedAt: string
  readonly temperatureC: number
  readonly humidityPct?: number
}

export interface ValidatedTelemetry extends RawTelemetry {
  readonly eventId: string
  readonly validatedAt: string
  readonly sourceStreamSequence: string
}

export interface TelemetryPolicy {
  readonly minimumTemperatureC: number
  readonly maximumTemperatureC: number
  readonly maximumFutureSkewMs: number
  readonly retryDelayMs: number
  readonly maximumDeliveries: number
}

export interface TelemetryPolicyInput {
  readonly minimumTemperatureC?: number
  readonly maximumTemperatureC?: number
  readonly maximumFutureSkewMs?: number
  readonly retryDelayMs?: number
  readonly maximumDeliveries?: number
}

export type TelemetryErrorCode =
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "INVALID_SHAPE"
  | "MISSING_REQUIRED_KEY"
  | "INVALID_IDENTIFIER"
  | "INVALID_SEQUENCE"
  | "INVALID_TIMESTAMP"
  | "FUTURE_TIMESTAMP"
  | "SUBJECT_DEVICE_MISMATCH"
  | "TEMPERATURE_OUT_OF_RANGE"
  | "HUMIDITY_OUT_OF_RANGE"
  | "RETRY_LIMIT"

/** Carries one stable permanent-validation code without leaking untrusted input. */
export class TelemetryValidationError extends Error {
  readonly code: TelemetryErrorCode

  constructor(code: TelemetryErrorCode) {
    super(code)
    this.name = "TelemetryValidationError"
    this.code = code
  }
}

/** Creates a validated, immutable policy from bounded operator inputs. */
export function newTelemetryPolicy(input: TelemetryPolicyInput = {}): TelemetryPolicy {
  const minimumTemperatureC = input.minimumTemperatureC ?? -80
  const maximumTemperatureC = input.maximumTemperatureC ?? 100
  const maximumFutureSkewMs = input.maximumFutureSkewMs ?? 60_000
  const retryDelayMs = input.retryDelayMs ?? 100
  const maximumDeliveries = input.maximumDeliveries ?? 5
  if (
    !Number.isFinite(minimumTemperatureC) ||
    !Number.isFinite(maximumTemperatureC) ||
    minimumTemperatureC > maximumTemperatureC
  ) {
    throw new RangeError("temperature range is invalid")
  }
  if (!Number.isInteger(maximumFutureSkewMs) || maximumFutureSkewMs < 0) {
    throw new RangeError("maximumFutureSkewMs must be a non-negative integer")
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("retryDelayMs must be a non-negative integer")
  }
  if (!Number.isInteger(maximumDeliveries) || maximumDeliveries < 1) {
    throw new RangeError("maximumDeliveries must be a positive integer")
  }
  return Object.freeze({
    minimumTemperatureC,
    maximumTemperatureC,
    maximumFutureSkewMs,
    retryDelayMs,
    maximumDeliveries
  })
}

export const defaultTelemetryPolicy = newTelemetryPolicy()
export const telemetryMediaType = "application/json"

/** Encodes one validated application event as standard JSON bytes. */
export function encodeValidatedTelemetry(value: ValidatedTelemetry): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

/** Decodes one raw payload with explicit required-key and calibrated business validation. */
export function decodeRawTelemetry(
  body: Uint8Array,
  policy: TelemetryPolicy,
  nowMs: number
): RawTelemetry {
  let text: string
  try {
    text = fatalDecoder.decode(body)
  } catch {
    throw new TelemetryValidationError("INVALID_UTF8")
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new TelemetryValidationError("INVALID_JSON")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TelemetryValidationError("INVALID_SHAPE")
  }
  for (const key of requiredRawKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TelemetryValidationError("MISSING_REQUIRED_KEY")
    }
  }
  const schemaVersion = Reflect.get(value, "schemaVersion")
  const messageId = Reflect.get(value, "messageId")
  const deviceId = Reflect.get(value, "deviceId")
  const sequence = Reflect.get(value, "sequence")
  const observedAt = Reflect.get(value, "observedAt")
  const temperatureC = Reflect.get(value, "temperatureC")
  const humidityPct = Reflect.get(value, "humidityPct")
  if (
    schemaVersion !== 1 ||
    typeof messageId !== "string" ||
    typeof deviceId !== "string" ||
    typeof sequence !== "string" ||
    typeof observedAt !== "string" ||
    typeof temperatureC !== "number" ||
    (humidityPct !== undefined && typeof humidityPct !== "number")
  ) {
    throw new TelemetryValidationError("INVALID_SHAPE")
  }
  const telemetry: RawTelemetry = {
    schemaVersion,
    messageId,
    deviceId,
    sequence,
    observedAt,
    temperatureC,
    ...(humidityPct === undefined ? {} : { humidityPct })
  }
  if (!identifierPattern.test(telemetry.messageId) || !identifierPattern.test(telemetry.deviceId)) {
    throw new TelemetryValidationError("INVALID_IDENTIFIER")
  }
  if (
    !sequencePattern.test(telemetry.sequence) ||
    BigInt(telemetry.sequence) > maximumUnsignedBigInt
  ) {
    throw new TelemetryValidationError("INVALID_SEQUENCE")
  }
  const observedAtMs = Date.parse(telemetry.observedAt)
  if (
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== telemetry.observedAt
  ) {
    throw new TelemetryValidationError("INVALID_TIMESTAMP")
  }
  if (observedAtMs > nowMs + policy.maximumFutureSkewMs) {
    throw new TelemetryValidationError("FUTURE_TIMESTAMP")
  }
  if (
    !Number.isFinite(telemetry.temperatureC) ||
    telemetry.temperatureC < policy.minimumTemperatureC ||
    telemetry.temperatureC > policy.maximumTemperatureC
  ) {
    throw new TelemetryValidationError("TEMPERATURE_OUT_OF_RANGE")
  }
  if (
    telemetry.humidityPct !== undefined &&
    (!Number.isFinite(telemetry.humidityPct) ||
      telemetry.humidityPct < 0 ||
      telemetry.humidityPct > 100)
  ) {
    throw new TelemetryValidationError("HUMIDITY_OUT_OF_RANGE")
  }
  return Object.freeze(telemetry)
}
