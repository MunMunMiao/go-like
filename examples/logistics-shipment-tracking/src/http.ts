import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { ShipmentStatus, TrackShipmentCommand, TrackingOutcome } from "./service"

type TrackShipmentEndpoint = (
  ctx: Context,
  command: TrackShipmentCommand
) => TrackingOutcome | Promise<TrackingOutcome>

function shipmentStatusFrom(value: unknown): ShipmentStatus {
  if (
    value === "created" ||
    value === "pickedUp" ||
    value === "inTransit" ||
    value === "outForDelivery" ||
    value === "delivered"
  ) {
    return value
  }
  throw new TypeError("invalid shipment status")
}

function commandFrom(value: unknown): TrackShipmentCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const eventId: unknown = Reflect.get(value, "eventId")
  const shipmentId: unknown = Reflect.get(value, "shipmentId")
  const status: unknown = Reflect.get(value, "status")
  const occurredAt: unknown = Reflect.get(value, "occurredAt")
  if (
    typeof eventId !== "string" ||
    typeof shipmentId !== "string" ||
    typeof occurredAt !== "number"
  ) {
    throw new TypeError("invalid tracking event")
  }
  return Object.freeze({
    eventId,
    shipmentId,
    status: shipmentStatusFrom(status),
    occurredAt
  })
}

/** Creates the standard Fetch entrypoint for carrier events. */
export function newShipmentTrackingHandler(trackShipment: TrackShipmentEndpoint): Handler {
  return contextHandler(async function shipmentTrackingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/tracking-events") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await trackShipment(ctx, commandFrom(await request.json())), {
        status: 202
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "tracking event rejected"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "tracking_event_rejected", message }, { status })
    }
  })
}
