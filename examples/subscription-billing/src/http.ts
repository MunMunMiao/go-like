import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { ChangeSubscription, ChangeSubscriptionCommand } from "./service"

function commandFrom(value: unknown): ChangeSubscriptionCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  const subscriptionId: unknown = Reflect.get(value, "subscriptionId")
  const oldUnitPriceCents: unknown = Reflect.get(value, "oldUnitPriceCents")
  const newUnitPriceCents: unknown = Reflect.get(value, "newUnitPriceCents")
  const quantity: unknown = Reflect.get(value, "quantity")
  const periodStart: unknown = Reflect.get(value, "periodStart")
  const periodEnd: unknown = Reflect.get(value, "periodEnd")
  const changedAt: unknown = Reflect.get(value, "changedAt")
  if (
    typeof requestId !== "string" ||
    typeof subscriptionId !== "string" ||
    typeof oldUnitPriceCents !== "number" ||
    typeof newUnitPriceCents !== "number" ||
    typeof quantity !== "number" ||
    typeof periodStart !== "number" ||
    typeof periodEnd !== "number" ||
    typeof changedAt !== "number"
  ) {
    throw new TypeError("invalid subscription change")
  }
  return Object.freeze({
    requestId,
    subscriptionId,
    oldUnitPriceCents,
    newUnitPriceCents,
    quantity,
    periodStart,
    periodEnd,
    changedAt
  })
}

/** Creates the standard Fetch endpoint for subscription changes. */
export function newSubscriptionBillingHandler(change: ChangeSubscription): Handler {
  return contextHandler(async function subscriptionBillingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/subscription-changes") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(change(ctx, commandFrom(await request.json())), { status: 201 })
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "subscription_change_rejected",
          message: error instanceof Error ? error.message : "change failed"
        },
        { status }
      )
    }
  })
}
