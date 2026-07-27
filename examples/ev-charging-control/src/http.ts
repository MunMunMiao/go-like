import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { StartCharging, StartChargingCommand } from "./service"

/** Decodes one untrusted charging request. */
function commandFrom(value: unknown): StartChargingCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid charging request")
  }
  const sessionId = Reflect.get(value, "sessionId")
  const stationId = Reflect.get(value, "stationId")
  const connectorId = Reflect.get(value, "connectorId")
  const requestedKw = Reflect.get(value, "requestedKw")
  if (
    typeof sessionId !== "string" ||
    typeof stationId !== "string" ||
    typeof connectorId !== "string" ||
    typeof requestedKw !== "number"
  ) {
    throw new TypeError("invalid charging request")
  }
  return Object.freeze({ sessionId, stationId, connectorId, requestedKw })
}

/** Creates the standard Fetch charging-control endpoint. */
export function newChargingHandler(startCharging: StartCharging): Handler {
  return contextHandler(async function chargingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/charging-sessions") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(startCharging(ctx, commandFrom(await request.json())), { status: 201 })
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      const message = error instanceof Error ? error.message : "charging request failed"
      return Response.json({ code: "charging_rejected", message }, { status })
    }
  })
}
