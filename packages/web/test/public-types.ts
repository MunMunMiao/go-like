import type { ProbeRegistry } from "@likego/health"
import * as WebPackage from "../src/index"
import {
  contextHandler,
  type ContextHandler,
  type ContextHandlerOptions,
  type Handler
} from "../src/index"
import { createHealthHandler, type HealthHandlerOptions } from "../src/health"

const contextualHandler: ContextHandler = (_ctx, _request) => new Response("ok")
const options: ContextHandlerOptions = { timeoutMs: 100 }
const webHandler: Handler = contextHandler(contextualHandler, options)

const inferredFetchHandler = contextHandler(
  (ctx, request) => {
    const deadline: readonly [Date, boolean] = ctx.deadline()
    const url: string = request.url
    void [deadline, url]
    return new Response("inferred")
  },
  { timeoutMs: 25 }
)
const inferredContract: Handler = inferredFetchHandler

const plainHandler: Handler = (_request) => new Response("plain")
const honoLike: {
  fetch(request: Request, env?: unknown, executionContext?: unknown): Response | Promise<Response>
} = { fetch: plainHandler }
const honoHandler: Handler = honoLike.fetch
const elysiaLike: { handle(request: Request): Promise<Response> } = {
  async handle(_request) {
    return new Response("elysia")
  }
}
const elysiaHandler: Handler = elysiaLike.handle
const ittyNarrowed: Handler = async (request) => {
  const raw: unknown = request.url
  return raw instanceof Response ? raw : new Response(String(raw))
}
const ittyRaw: (request: Request) => unknown = (_request) => ({ arbitrary: true })

declare const probeRegistry: ProbeRegistry
const healthOptions: HealthHandlerOptions = { livePath: "/livez", readyPath: "/readyz" }
const healthHandler: Handler = createHealthHandler(probeRegistry, healthOptions)

void [webHandler, inferredContract, honoHandler, elysiaHandler, ittyNarrowed, healthHandler]

// @ts-expect-error Raw itty-router-style arbitrary data must be narrowed to Response.
const invalidIttyHandler: Handler = ittyRaw
void invalidIttyHandler

// @ts-expect-error Handler is type-only.
WebPackage.Handler
// @ts-expect-error ContextHandler is type-only.
WebPackage.ContextHandler
// @ts-expect-error ContextHandlerOptions is type-only.
WebPackage.ContextHandlerOptions
// @ts-expect-error PascalCase aliases are not exported.
WebPackage.ToFetchHandler

// @ts-expect-error Handler has exactly one parameter.
const twoArgumentHandler: Handler = (_request, _ctx) => new Response("invalid")
void twoArgumentHandler
