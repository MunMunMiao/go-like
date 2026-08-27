import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import type { MonitorTemperature, TemperatureReading } from "./service"

/** Decodes one untrusted cold-chain reading. */
function temperatureReadingFrom(value: unknown): TemperatureReading {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid temperature reading")
  }
  const shipmentId = Reflect.get(value, "shipmentId")
  const sensorId = Reflect.get(value, "sensorId")
  const sequence = Reflect.get(value, "sequence")
  const temperatureC = Reflect.get(value, "temperatureC")
  if (
    typeof shipmentId !== "string" ||
    typeof sensorId !== "string" ||
    typeof sequence !== "number" ||
    typeof temperatureC !== "number"
  ) {
    throw new TypeError("invalid temperature reading")
  }
  return Object.freeze({ shipmentId, sensorId, sequence, temperatureC })
}

/** Creates the standard Fetch endpoint for cold-chain readings. */
export function newColdChainHandler(monitor: MonitorTemperature): Handler {
  return contextHandler(async function coldChainHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/cold-chain/readings") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(monitor(ctx, temperatureReadingFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json({ code: "invalid_temperature_reading" }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : "temperature monitoring failed"
      const status = message.includes("sequence") ? 409 : 503
      return Response.json({ code: "temperature_reading_rejected", message }, { status })
    }
  })
}
