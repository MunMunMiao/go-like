import { expiresIn, type Cache } from "@likego/cache"
import type { Context } from "@likego/context"
import { newProbeRegistry } from "@likego/health"
import { newHonoHandler } from "@likego/hono"
import { contextHandler, type Handler } from "@likego/web"
import { createHealthHandler } from "@likego/web/health"
import { Hono, type Context as HonoContext } from "hono"

import { decodePrice, encodePrice, fetchPrice, type PricingClient } from "./pricing"
import {
  findProduct,
  isProductId,
  isSupportedCurrency,
  maximumCacheTtlMs,
  type PriceQuote
} from "./catalog"

export interface CatalogHandlerOptions {
  readonly cache: Cache
  readonly client: PricingClient
}

/** Creates one stable JSON response without permitting intermediary price caching. */
function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  })
}

/** Creates the Hono catalog and health Handler around a Cache and internal Client. */
export function newCatalogHandler(options: CatalogHandlerOptions): Handler {
  const requestContexts = new WeakMap<Request, Context>()
  const probes = newProbeRegistry()
  probes.register("live", "catalog", function live(): void {})
  probes.register("ready", "cache", async function ready(ctx): Promise<void> {
    await options.cache.get(ctx, "health")
  })
  const health = createHealthHandler(probes)

  /** Serves one product lookup through the cache and Pricing client. */
  async function productRoute(context: HonoContext): Promise<Response> {
    const request = context.req.raw
    const ctx = requestContexts.get(request)
    if (ctx === undefined) return json(500, { error: "internal_context_missing" })
    const productId = context.req.param("productId")
    const currency = context.req.query("currency")
    if (
      productId === undefined ||
      !isProductId(productId) ||
      currency === undefined ||
      !isSupportedCurrency(currency)
    ) {
      return json(400, { error: "invalid_request" })
    }
    const product = findProduct(productId)
    if (product === null) return json(404, { error: "product_not_found" })
    const key = `price:v1:${currency}:${productId}`
    let selected: PriceQuote | null = null
    try {
      const cached = await options.cache.get(ctx, key)
      if (cached !== null) {
        selected = decodePrice(cached, productId, currency)
        if (selected === null) {
          try {
            await options.cache.delete(ctx, key)
          } catch {
            // Pricing remains the authority when cache cleanup fails.
          }
        }
      }
    } catch {
      // Cache availability does not change the authoritative Pricing path.
    }
    if (selected === null) {
      try {
        selected = await fetchPrice(ctx, options.client, productId, currency)
      } catch {
        return json(503, { error: "pricing_unavailable" })
      }
      if (selected === null) return json(502, { error: "invalid_pricing_response" })
      const ttl = Math.min(maximumCacheTtlMs, selected.validUntil - Date.now())
      if (ttl > 0) {
        try {
          await options.cache.put(
            ctx,
            key,
            encodePrice(selected),
            expiresIn(Math.max(1, Math.floor(ttl)))
          )
        } catch {
          // A verified Pricing result remains usable when cache population fails.
        }
      }
    }
    return json(200, {
      id: product.id,
      name: product.name,
      price: { currency: selected.currency, amountMinor: selected.amountMinor }
    })
  }

  const app = new Hono()
  app.get("/v1/products/:productId", productRoute)
  app.all("/livez", function live(context) {
    return health(context.req.raw)
  })
  app.all("/readyz", function ready(context) {
    return health(context.req.raw)
  })
  const hono = newHonoHandler(app)
  return contextHandler(async function requestHandler(ctx, request): Promise<Response> {
    requestContexts.set(request, ctx)
    try {
      return await hono(request)
    } finally {
      requestContexts.delete(request)
    }
  })
}
