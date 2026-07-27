import { newConfig, source, objectSource, type Config, type ConfigObject } from "@likego/config"

import { validateIrrigationPolicy, type IrrigationPolicy } from "./irrigation-policy"

/** Creates the LikeGo Config server that owns the irrigation policy value. */
export function newIrrigationConfig(policy: IrrigationPolicy): Config<ConfigObject> {
  validateIrrigationPolicy(policy)
  return newConfig(
    source(
      objectSource(
        "irrigation-policy",
        Object.freeze({
          irrigation: Object.freeze({
            triggerBelowPercent: policy.triggerBelowPercent,
            maxReadingAgeMs: policy.maxReadingAgeMs,
            maxLiters: policy.maxLiters
          })
        })
      )
    )
  )
}
