import type { Handler } from "@go-like/web"
import { Elysia } from "elysia"

import { userRoute } from "#src/routes"

/**
 * Creates an Elysia router exposed through the standard one-argument Fetch ABI.
 *
 * @returns A Fetch handler suitable for any go-like host adapter.
 */
export function newHandler(): Handler {
  const app = new Elysia().get("/users/:id", userRoute)
  return app.fetch
}
