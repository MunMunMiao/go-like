import type { Handler } from "@likego/web"

/** The smallest native Elysia boundary required by the LikeGo bridge. */
export interface ElysiaApplication {
  readonly fetch: (request: Request) => Response | Promise<Response>
}

/**
 * Captures one native Elysia application as a stable standard Web handler.
 *
 * Routing, hooks, error policy, and response construction remain owned by Elysia.
 */
export function newElysiaHandler(app: ElysiaApplication): Handler {
  if (app === null || typeof app !== "object" || typeof app.fetch !== "function") {
    throw new TypeError("app must be an Elysia application")
  }
  const fetch = app.fetch.bind(app)
  /** Delegates one standard Request without wrapping the native result. */
  function elysiaHandler(request: Request): Response | Promise<Response> {
    return fetch(request)
  }
  return elysiaHandler
}
