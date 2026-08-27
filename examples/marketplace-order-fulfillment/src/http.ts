import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { ApplyFulfillmentEvent, FulfillmentAction, FulfillmentCommand } from "./service"

/** Narrows one decoded string to the supported fulfillment actions. */
function isFulfillmentAction(value: string): value is FulfillmentAction {
  return (
    value === "reserveInventory" ||
    value === "capturePayment" ||
    value === "ship" ||
    value === "cancel"
  )
}

/** Decodes a fulfillment event from an unknown standard JSON body. */
function commandFrom(value: unknown): FulfillmentCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const eventId: unknown = Reflect.get(value, "eventId")
  const orderId: unknown = Reflect.get(value, "orderId")
  const action: unknown = Reflect.get(value, "action")
  if (
    typeof eventId !== "string" ||
    typeof orderId !== "string" ||
    typeof action !== "string" ||
    !isFulfillmentAction(action)
  ) {
    throw new TypeError("invalid fulfillment command")
  }
  return Object.freeze({ eventId, orderId, action })
}

/** Creates a standard Fetch endpoint for fulfillment events. */
export function newFulfillmentHandler(applyEvent: ApplyFulfillmentEvent): Handler {
  return contextHandler(async function fulfillmentHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/fulfillment-events") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(applyEvent(ctx, commandFrom(await request.json())))
    } catch (error) {
      const status = error instanceof TypeError ? 400 : 409
      return Response.json(
        { code: "transition_rejected", message: error instanceof Error ? error.message : "failed" },
        { status }
      )
    }
  })
}
