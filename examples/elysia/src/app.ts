import { newElysiaHandler } from "@likego/elysia"
import type { Handler } from "@likego/web"
import { Elysia } from "elysia"

import { userRoute } from "#src/routes"

/**
 * Creates an Elysia router exposed through the standard one-argument Fetch ABI.
 *
 * @returns A Fetch handler suitable for any LikeGo host adapter.
 */
export function newHandler(): Handler {
  const app = new Elysia().get("/users/:id", userRoute)
  return newElysiaHandler(app)
}
