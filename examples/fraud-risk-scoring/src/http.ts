import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import type { AssessTransactionCommand, RiskAssessment } from "./service"

type RiskAssessmentEndpoint = (
  ctx: Context,
  command: AssessTransactionCommand
) => RiskAssessment | Promise<RiskAssessment>

function commandFrom(value: unknown): AssessTransactionCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const transactionId: unknown = Reflect.get(value, "transactionId")
  const accountId: unknown = Reflect.get(value, "accountId")
  const amountMinor: unknown = Reflect.get(value, "amountMinor")
  const country: unknown = Reflect.get(value, "country")
  const homeCountry: unknown = Reflect.get(value, "homeCountry")
  const deviceTrusted: unknown = Reflect.get(value, "deviceTrusted")
  if (
    typeof transactionId !== "string" ||
    typeof accountId !== "string" ||
    typeof amountMinor !== "number" ||
    typeof country !== "string" ||
    typeof homeCountry !== "string" ||
    typeof deviceTrusted !== "boolean"
  ) {
    throw new TypeError("invalid transaction assessment")
  }
  return Object.freeze({
    transactionId,
    accountId,
    amountMinor,
    country,
    homeCountry,
    deviceTrusted
  })
}

/** Creates the standard Fetch endpoint for transaction risk assessments. */
export function newFraudRiskHandler(assess: RiskAssessmentEndpoint): Handler {
  return contextHandler(async function fraudRiskHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/risk-assessments") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await assess(ctx, commandFrom(await request.json())))
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "risk_assessment_rejected",
          message: error instanceof Error ? error.message : "assessment failed"
        },
        { status }
      )
    }
  })
}
