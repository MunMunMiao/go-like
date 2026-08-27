import { newConfig, objectSource, source, type Config, type ConfigObject } from "@go-like/config"
import { background, withCancel } from "@go-like/context"
import type { Handler } from "@go-like/web"
import { describe, expect, test } from "bun:test"

import { newEnergySettlementHandler } from "../src/http"
import {
  calculateSettlement,
  validateMeterReading,
  validateTariffRates
} from "../src/meter-settlement"
import { newSettleMeter } from "../src/service"
import { newTariffConfig } from "../src/tariff-config"

/** Creates a raw Config fixture for testing malformed public tariff documents. */
function newConfigForTest(document: ConfigObject): Config {
  return newConfig(source(objectSource("invalid-tariffs", document)))
}

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
  test("routes unknown requests and rejects malformed settlement bodies", async () => {
    await withSettlementHandler(
      { offPeakMinorPerKwh: 18, peakMinorPerKwh: 41 },
      async function verify(handler): Promise<void> {
        for (const request of [
          new Request("https://example.test/v1/energy-settlements", { method: "GET" }),
          new Request("https://example.test/other", { method: "POST", body: "{}" })
        ]) {
          const response = await handler(request)
          expect(response.status).toBe(404)
          expect(await response.json()).toEqual({ code: "not_found" })
        }
        for (const body of ["[]", JSON.stringify({ accountId: "account-1" }), "{"]) {
          const response = await handler(
            new Request("https://example.test/v1/energy-settlements", {
              method: "POST",
              body
            })
          )
          expect(response.status).toBe(body === "{" ? 503 : 400)
          expect(await response.json()).toMatchObject(
            body === "{" ? { code: "tariff_unavailable" } : { code: "invalid_meter_reading" }
          )
        }
      }
    )
  })

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

  test("validates reading and tariff boundaries before calculation", () => {
    for (const reading of [
      {
        accountId: "bad/id",
        meterId: "meter-1",
        period: "2026-07",
        tariffBand: "offPeak" as const,
        kilowattHours: 1
      },
      {
        accountId: "account-1",
        meterId: "meter-1",
        period: "2026-00",
        tariffBand: "offPeak" as const,
        kilowattHours: 1
      },
      {
        accountId: "account-1",
        meterId: "meter-1",
        period: "2026-07",
        tariffBand: "other" as never,
        kilowattHours: 1
      },
      {
        accountId: "account-1",
        meterId: "meter-1",
        period: "2026-07",
        tariffBand: "offPeak" as const,
        kilowattHours: 1.5
      }
    ]) {
      expect(() => validateMeterReading(reading)).toThrow()
    }
    expect(() => validateTariffRates({ offPeakMinorPerKwh: -1, peakMinorPerKwh: 1 })).toThrow(
      "non-negative safe integers"
    )
    expect(() =>
      calculateSettlement(
        {
          accountId: "account-1",
          meterId: "meter-1",
          period: "2026-07",
          tariffBand: "offPeak",
          kilowattHours: 1
        },
        { offPeakMinorPerKwh: 1, peakMinorPerKwh: -1 }
      )
    ).toThrow("non-negative safe integers")
  })

  test("fails invalid and negative readings before settlement", async () => {
    await withSettlementHandler(
      { offPeakMinorPerKwh: 18, peakMinorPerKwh: 41 },
      async function verify(handler): Promise<void> {
        for (const reading of [
          {
            accountId: "account-1",
            meterId: "meter-1",
            period: "2026-13",
            tariffBand: "offPeak",
            kilowattHours: -1
          },
          {
            accountId: "account-1",
            meterId: "meter-1",
            period: "2026-07",
            tariffBand: "peak",
            kilowattHours: 1.5
          }
        ]) {
          const response = await handler(
            new Request("https://example.test/v1/energy-settlements", {
              method: "POST",
              body: JSON.stringify(reading)
            })
          )
          expect(response.status).toBe(400)
        }
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

  test("rejects malformed Config tariff documents after load", async () => {
    const invalidConfigs = [{ tariffs: [] }, { tariffs: { offPeakMinorPerKwh: 18 } }]
    for (const document of invalidConfigs) {
      const config = newConfigForTest(document)
      await config.load(background())
      try {
        expect(() =>
          newSettleMeter(config)(background(), {
            accountId: "account-1",
            meterId: "meter-1",
            period: "2026-07",
            tariffBand: "offPeak",
            kilowattHours: 1
          })
        ).toThrow("tariff configuration is invalid")
      } finally {
        await config.close(background())
      }
    }
  })

  test("rejects settlement when the caller Context is already terminal", async () => {
    const config = newTariffConfig({ offPeakMinorPerKwh: 17, peakMinorPerKwh: 43 })
    await config.load(background())
    try {
      const canceled = withCancel(background())
      canceled[1]()
      expect(() =>
        newSettleMeter(config)(canceled[0], {
          accountId: "account-1",
          meterId: "meter-1",
          period: "2026-07",
          tariffBand: "offPeak",
          kilowattHours: 1
        })
      ).toThrow("context canceled")
    } finally {
      await config.close(background())
    }
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
