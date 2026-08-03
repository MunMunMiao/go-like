import { expiresIn, type Cache } from "@likego/cache"
import type { Config } from "@likego/config"
import type { Context } from "@likego/context"
import { newTokenBucketLimiter, type RateLimiter } from "@likego/resilience"
import { contextHandler, type Handler } from "@likego/web"
import { Hono, type Context as HonoContext } from "hono"
import type { Logger } from "pino"

import { decodeCached, encodeCached } from "./cache"
import {
  findTenantPolicy,
  isTenantToken,
  publicResponse,
  tenantDocumentSchema,
  type TenantDocument
} from "./config"

const RequestIdToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Resolves one already authenticated and authorized tenant identity. */
export type TenantResolver = (ctx: Context, request: Request) => string | Promise<string>

export interface TenantHandlerOptions {
  readonly config: Config<TenantDocument>
  readonly cache: Cache
  readonly logger: Logger
  readonly resolveTenant: TenantResolver
}

/** Creates one JSON response with stable cache prevention. */
function json(
  status: number,
  value: unknown,
  headers?: Readonly<Record<string, string>>
): Response {
  const responseHeaders = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  })
  if (headers !== undefined) {
    for (const [name, item] of Object.entries(headers)) responseHeaders.set(name, item)
  }
  return new Response(JSON.stringify(value), { status, headers: responseHeaders })
}

/** Returns one safe request identifier without trusting arbitrary header content. */
function requestId(request: Request): string {
  const supplied = request.headers.get("X-Request-Id")
  return supplied !== null && RequestIdToken.test(supplied) ? supplied : crypto.randomUUID()
}

/** Returns one stable public error response. */
function failure(status: number, code: string, id: string, retryAfterMs?: number): Response {
  const headers =
    retryAfterMs === undefined
      ? undefined
      : Object.freeze({ "Retry-After": String(Math.max(0, Math.ceil(retryAfterMs / 1_000))) })
  return json(status, { error: code, requestId: id }, headers)
}

/** Normalizes an internal error into one secret-free diagnostic class. */
function errorCode(value: unknown): string {
  if (value !== null && typeof value === "object") {
    try {
      const code = "code" in value ? value.code : null
      if (typeof code === "string" && isTenantToken(code)) return code
      const name = "name" in value ? value.name : null
      if (typeof name === "string" && isTenantToken(name)) return name
    } catch {
      return "UnknownError"
    }
  }
  return "UnknownError"
}

/** Creates the Hono public handler around Config, Redis-compatible Cache, limiter, and Pino. */
export function newTenantHandler(options: TenantHandlerOptions): Handler {
  const requestContexts = new WeakMap<Request, Context>()
  const limiters = new Map<string, RateLimiter>()
  let activeGeneration = ""

  /** Serves the sole tenant configuration route and logs exactly one terminal record. */
  async function serve(context: HonoContext): Promise<Response> {
    const request = context.req.raw
    const ctx = requestContexts.get(request)
    const id = requestId(request)
    const startedAt = performance.now()
    let tenantId: string | null = null
    let generation: string | null = null
    let cacheHit = false
    let rateLimited = false
    let status = 500
    let diagnostic: string | null = null
    try {
      if (ctx === undefined) {
        status = 500
        return failure(status, "internal_context_missing", id)
      }
      try {
        tenantId = await options.resolveTenant(ctx, request)
      } catch (error) {
        diagnostic = errorCode(error)
        status = 503
        return failure(status, "identity_unavailable", id)
      }
      if (!isTenantToken(tenantId)) {
        status = 401
        return failure(status, "identity_required", id)
      }
      let document: TenantDocument
      try {
        document = await options.config.scan(ctx, tenantDocumentSchema)
      } catch (error) {
        diagnostic = errorCode(error)
        status = 503
        return failure(status, "configuration_unavailable", id)
      }
      generation = document.generation
      const policy = findTenantPolicy(document, tenantId)
      if (policy === null) {
        status = 404
        return failure(status, "tenant_not_found", id)
      }
      if (!policy.enabled) {
        status = 403
        return failure(status, "tenant_disabled", id)
      }
      if (activeGeneration !== generation) {
        activeGeneration = generation
        limiters.clear()
      }
      const limiterKey = `${generation}:${tenantId}`
      let limiter = limiters.get(limiterKey)
      if (limiter === undefined) {
        limiter = newTokenBucketLimiter(policy.rateLimit)
        limiters.set(limiterKey, limiter)
      }
      const decision = limiter.allow(ctx)
      if (!decision.allowed) {
        rateLimited = true
        status = 429
        return failure(status, "rate_limited", id, decision.retryAfterMs)
      }
      const key = `config:v1:${generation}:${tenantId}`
      const response = publicResponse(tenantId, generation, policy)
      try {
        const cached = await options.cache.get(ctx, key)
        if (cached !== null) {
          const decoded = decodeCached(cached, tenantId, generation)
          if (decoded === null || JSON.stringify(decoded) !== JSON.stringify(response)) {
            diagnostic = "InvalidCachePayload"
            try {
              await options.cache.delete(ctx, key)
            } catch (error) {
              diagnostic = errorCode(error)
            }
          } else cacheHit = true
        }
      } catch (error) {
        diagnostic = errorCode(error)
      }
      if (!cacheHit) {
        try {
          await options.cache.put(ctx, key, encodeCached(response), expiresIn(document.cacheTtlMs))
        } catch (error) {
          diagnostic = errorCode(error)
        }
      }
      status = 200
      return json(status, response)
    } finally {
      options.logger.info(
        {
          requestId: id,
          tenantId,
          generation,
          route: "/v1/tenant/config",
          status,
          durationMs: Math.max(0, performance.now() - startedAt),
          cacheHit,
          rateLimited,
          diagnostic
        },
        "tenant config request"
      )
    }
  }

  const app = new Hono()
  app.get("/v1/tenant/config", serve)
  const hono: Handler = app.fetch
  return contextHandler(async function requestHandler(ctx, request): Promise<Response> {
    requestContexts.set(request, ctx)
    try {
      return await hono(request)
    } finally {
      requestContexts.delete(request)
    }
  })
}
