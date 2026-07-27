import type { Handler } from "@likego/web"
import { toWebHandler, type App } from "h3"

/** The native H3 application accepted by the LikeGo bridge. */
export type H3Application = App

/**
 * Converts one native H3 application to its standard Web handler.
 *
 * Routing, middleware, event creation, and response construction remain owned by H3.
 */
export function newH3Handler(app: H3Application): Handler {
  if (app === null || typeof app !== "object" || typeof app.handler !== "function") {
    throw new TypeError("app must be an H3 application")
  }
  return toWebHandler(app)
}
