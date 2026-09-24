import { createConnectRouter, type ConnectRouter } from "@connectrpc/connect"
import { createFetchHandler } from "@connectrpc/connect/protocol"

export type ServiceRegistrar = Pick<ConnectRouter, "service">
export type Routes = (server: ServiceRegistrar) => void

export function newHandler(routes: Routes): (request: Request) => Promise<Response> {
  const router = createConnectRouter({ connect: true, grpcWeb: true, grpc: false })
  routes(router)
  const handlers = new Map(
    router.handlers.map((handler) => [handler.requestPath, createFetchHandler(handler)])
  )
  return async (request) => {
    const handler = handlers.get(new URL(request.url).pathname)
    return handler === undefined ? new Response(null, { status: 404 }) : await handler(request)
  }
}
