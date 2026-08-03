import type { Handler } from "@likego/web"

import { requestSummary } from "#src/routes"

/**
 * Creates the reusable one-argument Fetch handler for this application.
 *
 * @returns A standard Fetch handler with no framework dependency.
 */
export function newHandler(): Handler {
  return requestSummary
}
