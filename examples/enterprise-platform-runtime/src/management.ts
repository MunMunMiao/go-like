import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

/** Calls the internal echo operation and returns its text. */
export interface EchoCaller {
  ping(ctx: Context): Promise<string>
}

/** Creates the management-plane Handler for health, metrics, and one internal service call. */
export function newManagementHandler(
  health: Handler,
  metrics: Handler,
  client: EchoCaller,
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
