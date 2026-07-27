import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type {
  RouteSupportCase,
  RouteSupportCaseCommand,
  SupportLanguage,
  SupportPriority
} from "./service"

/** Decodes one untrusted customer-support routing request. */
function supportCommandFrom(value: unknown): RouteSupportCaseCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid support routing request")
  }
  const caseId = Reflect.get(value, "caseId")
  const language = Reflect.get(value, "language")
  const priority = Reflect.get(value, "priority")
  if (
    typeof caseId !== "string" ||
    (language !== "en" && language !== "zh") ||
    (priority !== "standard" && priority !== "urgent")
  ) {
    throw new TypeError("invalid support routing request")
  }
  const selectedLanguage: SupportLanguage = language
  const selectedPriority: SupportPriority = priority
  return Object.freeze({
    caseId,
    language: selectedLanguage,
    priority: selectedPriority
  })
}

/** Creates the standard Fetch endpoint for support case routing. */
export function newSupportRoutingHandler(route: RouteSupportCase): Handler {
  return contextHandler(async function supportRoutingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/support/cases/route") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(route(ctx, supportCommandFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      if (error instanceof TypeError) {
        return Response.json({ code: "invalid_support_case" }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : "support routing failed"
      const status = message.includes("no eligible") ? 503 : 409
      return Response.json({ code: "support_routing_rejected", message }, { status })
    }
  })
}
