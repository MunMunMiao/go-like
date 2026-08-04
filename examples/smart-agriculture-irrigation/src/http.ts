import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import type { IrrigationCommand } from "./irrigation-policy"
import type { ScheduleIrrigation } from "./service"

/** Decodes one untrusted sensor command without retaining its carrier. */
function irrigationCommandFrom(value: unknown): IrrigationCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid irrigation request")
  }
  const fieldId = Reflect.get(value, "fieldId")
  const soilMoisturePercent = Reflect.get(value, "soilMoisturePercent")
  const observedAt = Reflect.get(value, "observedAt")
  const requestedLiters = Reflect.get(value, "requestedLiters")
  if (
    typeof fieldId !== "string" ||
    typeof soilMoisturePercent !== "number" ||
    typeof observedAt !== "number" ||
    typeof requestedLiters !== "number"
  ) {
    throw new TypeError("invalid irrigation request")
  }
  return Object.freeze({ fieldId, soilMoisturePercent, observedAt, requestedLiters })
}

/** Creates the standard Fetch irrigation-scheduling endpoint. */
export function newIrrigationHandler(schedule: ScheduleIrrigation): Handler {
  return contextHandler(async function irrigationHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/irrigation-decisions") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(schedule(ctx, irrigationCommandFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json(
          { code: "invalid_sensor_reading", message: error.message },
          { status: 400 }
        )
      }
      const message = error instanceof Error ? error.message : "irrigation decision failed"
      return Response.json({ code: "irrigation_rejected", message }, { status: 409 })
    }
  })
}
