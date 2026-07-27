import type { Handler } from "@likego/web"
import type { Hono } from "hono"

/**
 * Captures one native Hono application as a stable standard Web handler.
 *
 * Routing, middleware, error policy, and response construction remain owned by Hono.
 */
export function newHonoHandler(app: Hono): Handler {
  if (app === null || typeof app !== "object" || typeof app.fetch !== "function") {
    throw new TypeError("app must be a Hono application")
  }
  const fetch = app.fetch.bind(app)
  /** Delegates one standard Request without wrapping the native result. */
  function honoHandler(request: Request): Response | Promise<Response> {
    return fetch(request)
  }
  return honoHandler
}
