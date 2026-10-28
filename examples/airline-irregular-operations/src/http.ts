import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { DisruptionOutcome, ResolveDisruption, ResolveDisruptionCommand } from "./service"

function isOutcome(value: string): value is DisruptionOutcome {
  return value === "rebooked" || value === "refunded"
}

function commandFrom(value: unknown): ResolveDisruptionCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const caseId: unknown = Reflect.get(value, "caseId")
  const outcome: unknown = Reflect.get(value, "outcome")
  if (typeof caseId !== "string" || typeof outcome !== "string" || !isOutcome(outcome)) {
    throw new TypeError("invalid disruption command")
  }
  return Object.freeze({ caseId, outcome })
}

/** Creates the standard Fetch endpoint for disruption resolution. */
export function newDisruptionHandler(resolve: ResolveDisruption): Handler {
  return contextHandler(async function disruptionHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/disruptions/resolve") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(resolve(ctx, commandFrom(await request.json())))
    } catch (error) {
      const status = error instanceof TypeError ? 400 : 409
      return Response.json(
        {
          code: "disruption_resolution_rejected",
          message: error instanceof Error ? error.message : "resolution failed"
        },
        { status }
      )
    }
  })
}
