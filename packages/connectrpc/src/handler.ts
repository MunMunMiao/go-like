import { createConnectRouter, type ConnectRouter } from "@connectrpc/connect"
import {
  universalServerRequestFromFetch,
  universalServerResponseToFetch
} from "@connectrpc/connect/protocol"
import { requestContext } from "@go-like/core/web"

import { hostContextValues, serverInterceptor } from "./telemetry"

export type ServiceRegistrar = Pick<ConnectRouter, "service">
export type Routes = (server: ServiceRegistrar) => void

/**
 * Portable Connect and gRPC-Web handler.
 * Each call opens one `rpc.server` unit (`rpc.system.name` `connectrpc`) parented from the
 * request headers. The host Context, when one is bound to the `Request`, is the unit parent.
 */
export function newHandler(routes: Routes): (request: Request) => Promise<Response> {
  const router = createConnectRouter({
    connect: true,
    grpcWeb: true,
    grpc: false,
    interceptors: [serverInterceptor("connectrpc")]
  })
  routes(router)
  const handlers = new Map(router.handlers.map((handler) => [handler.requestPath, handler]))
  return async (request) => {
    const handler = handlers.get(new URL(request.url).pathname)
    if (handler === undefined) return new Response(null, { status: 404 })
    const universal = universalServerRequestFromFetch(request, {})
    const host = requestContext(request)
    if (host !== null) universal.contextValues = hostContextValues(host)
    return universalServerResponseToFetch(await handler(universal))
  }
}
