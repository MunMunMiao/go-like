import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { AdRequest } from "./campaigns"
import type { ServeAd } from "./service"

/** Converts unknown JSON into the explicit ad-request shape. */
function requestFrom(value: unknown): AdRequest {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  const placement: unknown = Reflect.get(value, "placement")
  const audienceSegment: unknown = Reflect.get(value, "audienceSegment")
  if (
    typeof requestId !== "string" ||
    typeof placement !== "string" ||
    typeof audienceSegment !== "string"
  ) {
    throw new TypeError("invalid ad request")
  }
  return Object.freeze({ requestId, placement, audienceSegment })
}

/** Creates the standard Fetch entrypoint for campaign serving. */
export function newAdServingHandler(serveAd: ServeAd): Handler {
  return contextHandler(async function adServingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/ads:serve") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await serveAd(ctx, requestFrom(await request.json())))
    } catch (error) {
      const message = error instanceof Error ? error.message : "ad serving failed"
      let status = 409
      if (error instanceof TypeError || error instanceof RangeError) status = 400
      if (message === "ad request rate limit exceeded") status = 429
      if (message === "creative is unavailable") status = 503
      return Response.json({ code: "ad_not_served", message }, { status })
    }
  })
}
