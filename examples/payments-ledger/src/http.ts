import { SQL } from "bun"

import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import { postPayment } from "./post-payment"
import { isPaymentFailure } from "./payment"

/** Creates the internal HTTP payment endpoint over one Context-aware tenant resolver. */
export function newPaymentHandler(
  sql: SQL,
  resolveTenant: (ctx: Context, request: Request) => string | Promise<string>
): Handler {
  return contextHandler(async (ctx, request) => {
    const url = new URL(request.url)
    if (url.pathname !== "/v1/ledger/payments") {
      return Response.json({ code: "NOT_FOUND" }, { status: 404 })
    }
    if (request.method !== "POST") {
      return Response.json(
        { code: "METHOD_NOT_ALLOWED" },
        { status: 405, headers: { Allow: "POST" } }
      )
    }
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? ""
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ code: "PAYMENT_VALIDATION" }, { status: 400 })
    }
    try {
      const tenantId = await resolveTenant(ctx, request)
      const receipt = await postPayment(ctx, sql, tenantId, idempotencyKey, body)
      return Response.json(receipt, { status: 201 })
    } catch (error) {
      if (isPaymentFailure(error)) {
        const status = error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400
        return Response.json({ code: error.code }, { status })
      }
      return Response.json({ code: "LEDGER_UNAVAILABLE" }, { status: 503 })
    }
  })
}
