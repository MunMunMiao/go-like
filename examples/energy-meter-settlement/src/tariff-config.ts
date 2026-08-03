import { newConfig, source, objectSource, type Config, type ConfigObject } from "@likego/config"

import { validateTariffRates, type TariffRates } from "./meter-settlement"

/** Creates the immutable tariff source and LikeGo Config lifecycle used by this example. */
export function newTariffConfig(rates: TariffRates): Config<ConfigObject> {
  validateTariffRates(rates)
  return newConfig(
    source(
      objectSource(
        "fixed-time-of-use-tariffs",
        Object.freeze({
          tariffs: Object.freeze({
            offPeakMinorPerKwh: rates.offPeakMinorPerKwh,
            peakMinorPerKwh: rates.peakMinorPerKwh
          })
        })
      )
    )
  )
}
