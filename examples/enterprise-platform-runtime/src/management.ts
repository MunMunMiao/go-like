import { contextHandler, type Handler } from "@go-like/web"

import type { EchoClient } from "./echo"

/** Creates the management-plane Handler for health, metrics, and one internal service call. */
export function newManagementHandler(
  health: Handler,
  metrics: Handler,
  client: EchoClient,
  onCallError: (error: unknown) => void = () => {}
): Handler {
  if (typeof onCallError !== "function") throw new TypeError("onCallError must be a function")

  return contextHandler(async function managementHandler(ctx, request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/metrics") return await metrics(request)
    if (path !== "/call") return await health(request)
    try {
      return Response.json({ response: await client.ping(ctx) })
    } catch (error) {
      onCallError(error)
      return Response.json({ code: "internal_call_failed" }, { status: 503 })
    }
  })
}
