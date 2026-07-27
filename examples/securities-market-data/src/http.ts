import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import { createHealthHandler } from "@likego/web/health"
import type { MarketQuoteCommand, PublishMarketQuote, SecuritiesMarketDataService } from "./service"

function commandFrom(value: unknown): MarketQuoteCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const symbol: unknown = Reflect.get(value, "symbol")
  const sequence: unknown = Reflect.get(value, "sequence")
  const bidPriceMicros: unknown = Reflect.get(value, "bidPriceMicros")
  const bidQuantity: unknown = Reflect.get(value, "bidQuantity")
  const askPriceMicros: unknown = Reflect.get(value, "askPriceMicros")
  const askQuantity: unknown = Reflect.get(value, "askQuantity")
  if (
    typeof symbol !== "string" ||
    typeof sequence !== "number" ||
    typeof bidPriceMicros !== "number" ||
    typeof bidQuantity !== "number" ||
    typeof askPriceMicros !== "number" ||
    typeof askQuantity !== "number"
  ) {
    throw new TypeError("invalid market quote")
  }
  return Object.freeze({
    symbol,
    sequence,
    bidPriceMicros,
    bidQuantity,
    askPriceMicros,
    askQuantity
  })
}

/** Creates the standard Fetch endpoint for market quote ingestion. */
export function newSecuritiesMarketDataHandler(publish: PublishMarketQuote): Handler {
  return contextHandler(async function securitiesMarketDataHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/market-quotes") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(publish(ctx, commandFrom(await request.json())), { status: 202 })
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "market_quote_rejected",
          message: error instanceof Error ? error.message : "quote failed"
        },
        { status }
      )
    }
  })
}

/** Routes quote ingestion and health probes through one standard Fetch handler. */
export function newSecuritiesMarketDataHTTP(service: SecuritiesMarketDataService): Handler {
  const ingest = newSecuritiesMarketDataHandler(service.publish)
  const health = createHealthHandler(service.probes)
  return function route(request: Request): Response | Promise<Response> {
    const pathname = new URL(request.url).pathname
    return pathname === "/livez" || pathname === "/readyz" ? health(request) : ingest(request)
  }
}
