import { newConfig, source, objectSource, type Config, type ConfigObject } from "@likego/config"
import type { Context } from "@likego/context"

import {
  validateTemperatureLimits,
  type TemperatureAssessment,
  type TemperatureLimits
} from "./service"

export interface TemperatureLedger {
  record(ctx: Context, assessment: TemperatureAssessment): TemperatureAssessment
}

/** Creates the immutable temperature source and LikeGo Config lifecycle. */
export function newTemperatureConfig(limits: TemperatureLimits): Config<ConfigObject> {
  validateTemperatureLimits(limits)
  return newConfig(
    source(
      objectSource(
        "fixed-cold-chain-limits",
        Object.freeze({
          coldChain: Object.freeze({
            minimumC: limits.minimumC,
            maximumC: limits.maximumC
          })
        })
      )
    )
  )
}

/** Creates an in-memory ledger enforcing monotonic shipment sequences. */
export function newMemoryTemperatureLedger(): TemperatureLedger {
  const latest = new Map<string, TemperatureAssessment>()
  return Object.freeze({
    record(ctx: Context, assessment: TemperatureAssessment): TemperatureAssessment {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = latest.get(assessment.shipmentId)
      if (current !== undefined) {
        if (
          current.sequence === assessment.sequence &&
          current.sensorId === assessment.sensorId &&
          current.temperatureC === assessment.temperatureC
        ) {
          return current
        }
        if (assessment.sequence <= current.sequence) {
          throw new Error("reading sequence is stale or conflicting")
        }
      }
      latest.set(assessment.shipmentId, assessment)
      return assessment
    }
  })
}
