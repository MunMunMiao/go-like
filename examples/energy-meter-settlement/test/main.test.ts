import { background } from "@go-like/context"
import type { Handler } from "@go-like/web"
import { describe, expect, test } from "bun:test"

import { newEnergySettlementHandler } from "../src/http"
import { calculateSettlement } from "../src/meter-settlement"
import { newSettleMeter } from "../src/service"
import { newTariffConfig } from "../src/tariff-config"

/** Runs one handler while the Config lifecycle remains explicit. */
async function withSettlementHandler(
  rates: { readonly offPeakMinorPerKwh: number; readonly peakMinorPerKwh: number },
  run: (handler: Handler) => Promise<void>
): Promise<void> {
  const config = newTariffConfig(rates)
  const handler = newEnergySettlementHandler(newSettleMeter(config))
  await config.load(background())
  try {
    await run(handler)
  } finally {
    await config.close(background())
  }
}

describe("energy meter settlement", () => {
  test("uses the selected immutable time-of-use rate", async () => {
    const rates = { offPeakMinorPerKwh: 17, peakMinorPerKwh: 43 }
    await withSettlementHandler(rates, async function verify(handler): Promise<void> {
      rates.peakMinorPerKwh = 999
      const response = await handler(
        new Request("https://example.test/v1/energy-settlements", {
          method: "POST",
          body: JSON.stringify({
            accountId: "account-1",
            meterId: "meter-1",
            period: "2026-07",
            tariffBand: "peak",
            kilowattHours: 12
          })
        })
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        rateMinorPerKwh: 43,
        amountMinor: 516
      })
    })
  })

  test("fails invalid and negative readings before settlement", async () => {
    await withSettlementHandler(
      { offPeakMinorPerKwh: 18, peakMinorPerKwh: 41 },
      async function verify(handler): Promise<void> {
        const response = await handler(
          new Request("https://example.test/v1/energy-settlements", {
            method: "POST",
            body: JSON.stringify({
              accountId: "account-1",
              meterId: "meter-1",
              period: "2026-13",
              tariffBand: "offPeak",
              kilowattHours: -1
            })
          })
        )
        expect(response.status).toBe(400)
      }
    )
  })

  test("refuses unsafe integer settlement totals", () => {
    expect(() =>
      calculateSettlement(
        {
          accountId: "account-1",
          meterId: "meter-1",
          period: "2026-07",
          tariffBand: "peak",
          kilowattHours: Number.MAX_SAFE_INTEGER
        },
        { offPeakMinorPerKwh: 1, peakMinorPerKwh: 2 }
      )
    ).toThrow("settlement amount exceeds safe range")
  })

  test("does not settle before go-like Config loads a value", () => {
    const config = newTariffConfig({ offPeakMinorPerKwh: 17, peakMinorPerKwh: 43 })
    expect(() =>
      newSettleMeter(config)(background(), {
        accountId: "account-1",
        meterId: "meter-1",
        period: "2026-07",
        tariffBand: "offPeak",
        kilowattHours: 1
      })
    ).toThrow("tariff configuration is not ready")
  })
})
