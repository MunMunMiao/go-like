import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { AlertSource, SecurityAlert, TriageAlert } from "./service"

/** Decodes one untrusted security alert request. */
function securityAlertFrom(value: unknown): SecurityAlert {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid security alert")
  }
  const alertId = Reflect.get(value, "alertId")
  const source = Reflect.get(value, "source")
  const failedAttempts = Reflect.get(value, "failedAttempts")
  const malwareConfidence = Reflect.get(value, "malwareConfidence")
  const privileged = Reflect.get(value, "privileged")
  if (
    typeof alertId !== "string" ||
    (source !== "endpoint" && source !== "identity" && source !== "network") ||
    typeof failedAttempts !== "number" ||
    typeof malwareConfidence !== "number" ||
    typeof privileged !== "boolean"
  ) {
    throw new TypeError("invalid security alert")
  }
  const selectedSource: AlertSource = source
  return Object.freeze({
    alertId,
    source: selectedSource,
    failedAttempts,
    malwareConfidence,
    privileged
  })
}

/** Creates the standard Fetch endpoint for security alert triage. */
export function newSecurityTriageHandler(triage: TriageAlert): Handler {
  return contextHandler(async function securityTriageHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/v1/security/alerts/triage"
    ) {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await triage(ctx, securityAlertFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json({ code: "invalid_security_alert" }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : "security triage failed"
      const status = message.includes("different alert") ? 409 : 503
      return Response.json({ code: "security_triage_rejected", message }, { status })
    }
  })
}
