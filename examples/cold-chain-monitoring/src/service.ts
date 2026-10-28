import type { Config, ConfigObject } from "@go-like/config"
import type { Context } from "@go-like/context"
import type { TemperatureLedger } from "./config"

const publicId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export interface TemperatureReading {
  readonly shipmentId: string
  readonly sensorId: string
  readonly sequence: number
  readonly temperatureC: number
}

export interface TemperatureLimits {
  readonly minimumC: number
  readonly maximumC: number
}

export interface TemperatureAssessment extends TemperatureReading {
  readonly minimumC: number
  readonly maximumC: number
  readonly status: "breach" | "withinRange"
}

/** Validates one cold-chain temperature rule set. */
export function validateTemperatureLimits(limits: TemperatureLimits): void {
  if (
    !Number.isFinite(limits.minimumC) ||
    !Number.isFinite(limits.maximumC) ||
    limits.minimumC >= limits.maximumC
  ) {
    throw new RangeError("minimumC must be lower than maximumC")
  }
}

/** Validates one sensor reading before sequence or threshold decisions. */
export function validateTemperatureReading(reading: TemperatureReading): void {
  if (!publicId.test(reading.shipmentId) || !publicId.test(reading.sensorId)) {
    throw new TypeError("invalid shipment or sensor identity")
  }
  if (!Number.isSafeInteger(reading.sequence) || reading.sequence < 1) {
    throw new RangeError("sequence must be a positive safe integer")
  }
  if (
    !Number.isFinite(reading.temperatureC) ||
    reading.temperatureC < -100 ||
    reading.temperatureC > 100
  ) {
    throw new RangeError("temperatureC must be between -100 and 100")
  }
}

/** Assesses one validated reading against an inclusive allowed temperature range. */
export function assessTemperature(
  reading: TemperatureReading,
  limits: TemperatureLimits
): TemperatureAssessment {
  validateTemperatureReading(reading)
  validateTemperatureLimits(limits)
  const status =
    reading.temperatureC < limits.minimumC || reading.temperatureC > limits.maximumC
      ? "breach"
      : "withinRange"
  return Object.freeze({
    shipmentId: reading.shipmentId,
    sensorId: reading.sensorId,
    sequence: reading.sequence,
    temperatureC: reading.temperatureC,
    minimumC: limits.minimumC,
    maximumC: limits.maximumC,
    status
  })
}

export type MonitorTemperature = (
  ctx: Context,
  reading: TemperatureReading
) => TemperatureAssessment

/** Reads the current temperature limits from one Config value. */
function currentLimits(config: Config<ConfigObject>): TemperatureLimits {
  const coldChain = config.value("coldChain").load()
  if (coldChain === null) throw new Error("temperature configuration is not ready")
  if (typeof coldChain !== "object" || Array.isArray(coldChain)) {
    throw new Error("temperature configuration is invalid")
  }
  const minimumC = Reflect.get(coldChain, "minimumC")
  const maximumC = Reflect.get(coldChain, "maximumC")
  if (typeof minimumC !== "number" || typeof maximumC !== "number") {
    throw new Error("temperature configuration is invalid")
  }
  return Object.freeze({ minimumC, maximumC })
}

/** Creates the Context-first cold-chain monitoring use case. */
export function newMonitorTemperature(
  config: Config<ConfigObject>,
  ledger: TemperatureLedger
): MonitorTemperature {
  return function monitorTemperature(
    ctx: Context,
    reading: TemperatureReading
  ): TemperatureAssessment {
    const failure = ctx.err()
    if (failure !== null) throw failure
    return ledger.record(ctx, assessTemperature(reading, currentLimits(config)))
  }
}
