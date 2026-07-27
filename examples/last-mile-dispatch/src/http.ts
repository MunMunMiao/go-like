import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import type { DispatchCommand, DispatchDelivery } from "./service"

function commandFrom(value: unknown): DispatchCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const deliveryId: unknown = Reflect.get(value, "deliveryId")
  const requiredCapacity: unknown = Reflect.get(value, "requiredCapacity")
  if (typeof deliveryId !== "string" || typeof requiredCapacity !== "number") {
    throw new TypeError("invalid dispatch command")
  }
  return Object.freeze({ deliveryId, requiredCapacity })
}

/** Creates the standard Fetch endpoint for delivery dispatch. */
export function newDispatchHandler(dispatch: DispatchDelivery): Handler {
  return contextHandler(async function dispatchHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/dispatches") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(dispatch(ctx, commandFrom(await request.json())), { status: 201 })
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "dispatch_rejected",
          message: error instanceof Error ? error.message : "dispatch failed"
        },
        { status }
      )
    }
  })
}
