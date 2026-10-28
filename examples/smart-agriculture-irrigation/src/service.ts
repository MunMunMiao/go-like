import type { Config, ConfigObject } from "@go-like/config"
import type { Context } from "@go-like/context"

import {
  decideIrrigation,
  type IrrigationCommand,
  type IrrigationDecision,
  type IrrigationPolicy
} from "./irrigation-policy"

export type ScheduleIrrigation = (ctx: Context, command: IrrigationCommand) => IrrigationDecision

/** Reads the admitted irrigation policy from the current Config value. */
function currentPolicy(config: Config<ConfigObject>): IrrigationPolicy {
  const policy = config.value("irrigation").load()
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("irrigation configuration is invalid")
  }
  const triggerBelowPercent = Reflect.get(policy, "triggerBelowPercent")
  const maxReadingAgeMs = Reflect.get(policy, "maxReadingAgeMs")
  const maxLiters = Reflect.get(policy, "maxLiters")
  if (
    typeof triggerBelowPercent !== "number" ||
    typeof maxReadingAgeMs !== "number" ||
    typeof maxLiters !== "number"
  ) {
    throw new Error("irrigation configuration is invalid")
  }
  return Object.freeze({ triggerBelowPercent, maxReadingAgeMs, maxLiters })
}

/** Creates a Context-first irrigation scheduler backed by go-like Config. */
export function newScheduleIrrigation(
  config: Config<ConfigObject>,
  now: () => number = Date.now
): ScheduleIrrigation {
  return function scheduleIrrigation(ctx: Context, command: IrrigationCommand): IrrigationDecision {
    const failure = ctx.err()
    if (failure !== null) throw failure
    return decideIrrigation(command, currentPolicy(config), now())
  }
}
