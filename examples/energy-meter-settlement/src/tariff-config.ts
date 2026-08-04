import { newConfig, source, objectSource, type Config, type ConfigObject } from "@go-like/config"

import { validateTariffRates, type TariffRates } from "./meter-settlement"

/** Creates the immutable tariff source and go-like Config lifecycle used by this example. */
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
