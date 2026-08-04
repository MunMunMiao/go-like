import type { Handler } from "@go-like/web"
import { Hono } from "hono"

import { userRoute } from "#src/routes"

/**
 * Creates a Hono router exposed through the standard one-argument Fetch ABI.
 *
 * @returns A Fetch handler suitable for any go-like host adapter.
 */
export function newHandler(): Handler {
  const app = new Hono()
  app.get("/users/:id", userRoute)
  return app.fetch
}
