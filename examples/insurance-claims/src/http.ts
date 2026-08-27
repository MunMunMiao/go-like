import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { SubmitClaim, SubmitClaimCommand } from "./service"

function commandFrom(value: unknown): SubmitClaimCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const claimId: unknown = Reflect.get(value, "claimId")
  const policyId: unknown = Reflect.get(value, "policyId")
  const incidentAt: unknown = Reflect.get(value, "incidentAt")
  const lossCents: unknown = Reflect.get(value, "lossCents")
  if (
    typeof claimId !== "string" ||
    typeof policyId !== "string" ||
    typeof incidentAt !== "number" ||
    typeof lossCents !== "number"
  ) {
    throw new TypeError("invalid claim")
  }
  return Object.freeze({ claimId, policyId, incidentAt, lossCents })
}

/** Creates the standard Fetch endpoint for insurance claims. */
export function newInsuranceClaimsHandler(submit: SubmitClaim): Handler {
  return contextHandler(async function insuranceClaimsHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/claims") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(submit(ctx, commandFrom(await request.json())), { status: 201 })
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "claim_rejected",
          message: error instanceof Error ? error.message : "claim failed"
        },
        { status }
      )
    }
  })
}
