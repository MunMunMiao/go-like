import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import type { GetAvailableStock, ReserveStock, ReserveStockCommand } from "./service"

/** Converts an unknown JSON value into the explicit reservation command shape. */
function commandFrom(value: unknown): ReserveStockCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  const sku: unknown = Reflect.get(value, "sku")
  const quantity: unknown = Reflect.get(value, "quantity")
  const expiresAt: unknown = Reflect.get(value, "expiresAt")
  if (
    typeof requestId !== "string" ||
    typeof sku !== "string" ||
    typeof quantity !== "number" ||
    typeof expiresAt !== "number"
  ) {
    throw new TypeError("invalid reservation command")
  }
  return Object.freeze({
    requestId,
    sku,
    quantity,
    expiresAt
  })
}

/** Creates the standard Fetch entrypoint for the reservation use case. */
export function newReservationHandler(
  reserveStock: ReserveStock,
  getAvailableStock: GetAvailableStock
): Handler {
  return contextHandler(async function reservationHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname.startsWith("/v1/inventory/")) {
      try {
        const sku = decodeURIComponent(url.pathname.slice("/v1/inventory/".length))
        return Response.json(await getAvailableStock(ctx, sku))
      } catch (error) {
        const status =
          error instanceof TypeError || error instanceof RangeError || error instanceof URIError
            ? 400
            : 404
        return Response.json(
          {
            code: "inventory_query_rejected",
            message: error instanceof Error ? error.message : "failed"
          },
          { status }
        )
      }
    }
    if (request.method !== "POST" || url.pathname !== "/v1/reservations") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      const reservation = await reserveStock(ctx, commandFrom(await request.json()))
      return Response.json(reservation, { status: 201 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "reservation failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "reservation_rejected", message }, { status })
    }
  })
}
