import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { MeterReading, TariffBand } from "./meter-settlement"
import type { SettleMeter } from "./service"

/** Decodes one untrusted settlement request without retaining its input object. */
function meterReadingFrom(value: unknown): MeterReading {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid settlement request")
  }
  const accountId = Reflect.get(value, "accountId")
  const meterId = Reflect.get(value, "meterId")
  const period = Reflect.get(value, "period")
  const tariffBand = Reflect.get(value, "tariffBand")
  const kilowattHours = Reflect.get(value, "kilowattHours")
  if (
    typeof accountId !== "string" ||
    typeof meterId !== "string" ||
    typeof period !== "string" ||
    (tariffBand !== "offPeak" && tariffBand !== "peak") ||
    typeof kilowattHours !== "number"
  ) {
    throw new TypeError("invalid settlement request")
  }
  const selectedBand: TariffBand = tariffBand
  return Object.freeze({ accountId, meterId, period, tariffBand: selectedBand, kilowattHours })
}

/** Creates the standard Fetch entrypoint for meter settlement. */
export function newEnergySettlementHandler(settle: SettleMeter): Handler {
  return contextHandler(async function energySettlementHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/energy-settlements") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      const settlement = settle(ctx, meterReadingFrom(await request.json()))
      return Response.json(settlement, { status: 201 })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json(
          { code: "invalid_meter_reading", message: error.message },
          { status: 400 }
        )
      }
      return Response.json({ code: "tariff_unavailable" }, { status: 503 })
    }
  })
}
