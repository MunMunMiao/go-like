import { newH3Handler } from "@likego/h3"
import type { Handler } from "@likego/web"
import { createApp, createRouter, defineEventHandler } from "h3"

import { statusRoute } from "#src/routes"

/**
 * Creates a stable H3 router exposed through its Web Handler API.
 *
 * @returns A Fetch handler suitable for any LikeGo host adapter.
 */
export function newHandler(): Handler {
  const router = createRouter().get("/status", defineEventHandler(statusRoute))
  const app = createApp().use(router.handler)
  return newH3Handler(app)
}
