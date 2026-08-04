import type { Handler } from "@go-like/web"
import { H3 } from "h3"

import { statusRoute } from "#src/routes"

/**
 * Creates a stable H3 router exposed through its Web Handler API.
 *
 * @returns A Fetch handler suitable for any go-like host adapter.
 */
export function newHandler(): Handler {
  return new H3().get("/status", statusRoute).fetch
}
