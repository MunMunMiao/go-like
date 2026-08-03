import type { Handler } from "@likego/web"
import { Hono } from "hono"

import { userRoute } from "#src/routes"

/**
 * Creates a Hono router exposed through the standard one-argument Fetch ABI.
 *
 * @returns A Fetch handler suitable for any LikeGo host adapter.
 */
export function newHandler(): Handler {
  const app = new Hono()
  app.get("/users/:id", userRoute)
  return app.fetch
}
