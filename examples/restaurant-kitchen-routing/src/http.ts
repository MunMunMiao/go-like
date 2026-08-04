import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import type { KitchenStation, RouteKitchenTicket, RouteKitchenTicketCommand } from "./service"

/** Decodes one untrusted kitchen routing request. */
function kitchenCommandFrom(value: unknown): RouteKitchenTicketCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid kitchen routing request")
  }
  const ticketId = Reflect.get(value, "ticketId")
  const station = Reflect.get(value, "station")
  const itemCount = Reflect.get(value, "itemCount")
  if (
    typeof ticketId !== "string" ||
    (station !== "fryer" && station !== "grill" && station !== "pastry") ||
    typeof itemCount !== "number"
  ) {
    throw new TypeError("invalid kitchen routing request")
  }
  const selectedStation: KitchenStation = station
  return Object.freeze({ ticketId, station: selectedStation, itemCount })
}

/** Creates the standard Fetch endpoint for kitchen ticket routing. */
export function newKitchenRoutingHandler(route: RouteKitchenTicket): Handler {
  return contextHandler(async function kitchenRoutingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/v1/kitchen/tickets/route"
    ) {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      const assignment = await route(ctx, kitchenCommandFrom(await request.json()))
      return Response.json(assignment, { status: 201 })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json({ code: "invalid_kitchen_ticket" }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : "kitchen routing failed"
      const status = message.includes("unavailable") ? 503 : 409
      return Response.json({ code: "kitchen_routing_rejected", message }, { status })
    }
  })
}
