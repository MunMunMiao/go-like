import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import type { ProvisionServiceCommand, TelecomPlan } from "./service"
import type { TelecomProvisioningClient } from "./transport"

/** Decodes one untrusted public provisioning request. */
function commandFrom(value: unknown): ProvisionServiceCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid provisioning request")
  }
  const orderId = Reflect.get(value, "orderId")
  const subscriberId = Reflect.get(value, "subscriberId")
  const simId = Reflect.get(value, "simId")
  const plan = Reflect.get(value, "plan")
  if (
    typeof orderId !== "string" ||
    typeof subscriberId !== "string" ||
    typeof simId !== "string" ||
    (plan !== "mobile-basic" && plan !== "mobile-premium")
  ) {
    throw new TypeError("invalid provisioning request")
  }
  const selectedPlan: TelecomPlan = plan
  return Object.freeze({ orderId, subscriberId, simId, plan: selectedPlan })
}

/** Creates the public Fetch adapter that calls the internal provisioning service. */
export function newTelecomProvisioningHandler(client: TelecomProvisioningClient): Handler {
  return contextHandler(async function telecomProvisioningHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/telecom-services") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await client.provision(ctx, commandFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      if (error instanceof TypeError) {
        return Response.json({ code: "invalid_provisioning_request" }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : "provisioning failed"
      return Response.json({ code: "provisioning_rejected", message }, { status: 409 })
    }
  })
}
