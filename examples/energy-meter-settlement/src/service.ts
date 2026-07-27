import type { Config, ConfigObject } from "@likego/config"
import type { Context } from "@likego/context"

import {
  calculateSettlement,
  type EnergySettlement,
  type MeterReading,
  type TariffRates
} from "./meter-settlement"

export type SettleMeter = (ctx: Context, reading: MeterReading) => EnergySettlement

/** Reads one validated tariff document from the current Config value. */
function currentRates(config: Config<ConfigObject>): TariffRates {
  const tariffs = config.value("tariffs").load()
  if (tariffs === null) throw new Error("tariff configuration is not ready")
  if (typeof tariffs !== "object" || Array.isArray(tariffs)) {
    throw new Error("tariff configuration is invalid")
  }
  const offPeakMinorPerKwh = Reflect.get(tariffs, "offPeakMinorPerKwh")
  const peakMinorPerKwh = Reflect.get(tariffs, "peakMinorPerKwh")
  if (typeof offPeakMinorPerKwh !== "number" || typeof peakMinorPerKwh !== "number") {
    throw new Error("tariff configuration is invalid")
  }
  return Object.freeze({ offPeakMinorPerKwh, peakMinorPerKwh })
}

/** Creates the Context-first settlement use case backed by LikeGo Config. */
export function newSettleMeter(config: Config<ConfigObject>): SettleMeter {
  return function settleMeter(ctx: Context, reading: MeterReading): EnergySettlement {
    const failure = ctx.err()
    if (failure !== null) throw failure
    return calculateSettlement(reading, currentRates(config))
  }
}
