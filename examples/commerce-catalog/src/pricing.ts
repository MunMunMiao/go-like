import { withFilter, withRetry, type CallOption, type Client } from "@go-like/client"
import type { Context } from "@go-like/context"
import { filterVersion } from "@go-like/registry"
import { exponentialBackoff } from "@go-like/resilience"

import {
  findAmountMinor,
  isProductId,
  isSupportedCurrency,
  maximumCacheTtlMs,
  type PriceQuote
} from "./catalog"
import { pricing } from "./contract"

const jsonEncoder = new TextEncoder()
const jsonDecoder = new TextDecoder("utf-8", { fatal: true })

/** Describes the typed Pricing caller borrowed from one common Client owner. */
export interface PricingClient {
  /** Fetches one validated internal Pricing quote. */
  fetchPrice(
    ctx: Context,
    productId: string,
    currency: string,
    ...options: readonly CallOption[]
  ): Promise<PriceQuote | null>
}

/** Decodes one Pricing request accepted by the service handler. */
export interface PricingRequest {
  readonly productId: string
  readonly currency: string
}

/** Decodes and validates one Pricing response or cache payload. */
export function decodePrice(
  bytes: Uint8Array,
  productId: string,
  currency: string
): PriceQuote | null {
  try {
    const value: unknown = JSON.parse(jsonDecoder.decode(bytes))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const responseProductId = Reflect.get(value, "productId")
    const responseCurrency = Reflect.get(value, "currency")
    const amountMinor = Reflect.get(value, "amountMinor")
    const validUntil = Reflect.get(value, "validUntil")
    if (
      responseProductId !== productId ||
      responseCurrency !== currency ||
      typeof amountMinor !== "number" ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 0 ||
      typeof validUntil !== "number" ||
      !Number.isSafeInteger(validUntil) ||
      validUntil <= Date.now()
    ) {
      return null
    }
    return Object.freeze({
      productId: responseProductId,
      currency: responseCurrency,
      amountMinor,
      validUntil
    })
  } catch {
    return null
  }
}

/** Encodes one verified price for transport or cache storage. */
export function encodePrice(value: PriceQuote): Uint8Array {
  return jsonEncoder.encode(JSON.stringify(value))
}

/** Creates the typed Pricing caller with its existing filter and retry policy. */
export function newPricingClient(client: Client): PricingClient {
  const caller = pricing.newClient(client)
  return Object.freeze({
    async fetchPrice(
      ctx: Context,
      productId: string,
      currency: string,
      ...options: readonly CallOption[]
    ): Promise<PriceQuote | null> {
      const quote = await caller.get(
        ctx,
        { productId, currency },
        withFilter(filterVersion("v1")),
        withRetry({
          authorization: "idempotent",
          maxAttempts: 3,
          shouldRetry(_attemptContext, failure) {
            return failure instanceof TypeError
          },
          backoff: exponentialBackoff({ initialDelayMs: 10, maxDelayMs: 50 })
        }),
        ...options
      )
      return decodePrice(encodePrice(quote), productId, currency)
    }
  })
}

/** Creates the pricing.v1 get handler registered directly on a go-like Server. */
export function newPricingHandler(
  onCall: () => void = () => {}
): (ctx: Context, request: PricingRequest) => PriceQuote {
  return function pricingHandler(_ctx: Context, request: PricingRequest): PriceQuote {
    if (!isProductId(request.productId) || !isSupportedCurrency(request.currency)) {
      throw new TypeError("invalid pricing request")
    }
    const amountMinor = findAmountMinor(request.productId, request.currency)
    if (amountMinor === null) throw new TypeError("price is unavailable")
    onCall()
    return Object.freeze({
      productId: request.productId,
      currency: request.currency,
      amountMinor,
      validUntil: Date.now() + maximumCacheTtlMs
    })
  }
}
