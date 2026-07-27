import { withFilter, withRetry, type CallOption, type CallRequest } from "@likego/client"
import type { Context } from "@likego/context"
import { filterVersion } from "@likego/registry"
import { exponentialBackoff } from "@likego/resilience"
import type { Handler } from "@likego/server"
import type { Message } from "@likego/transport"

import {
  findAmountMinor,
  isProductId,
  isSupportedCurrency,
  maximumCacheTtlMs,
  type PriceQuote
} from "./catalog"

const jsonMediaType = "application/json"
const jsonEncoder = new TextEncoder()
const jsonDecoder = new TextDecoder("utf-8", { fatal: true })

/** Describes the raw unary Client capability used by the Pricing caller. */
export interface PricingClient {
  /** Calls one internal Pricing operation. */
  call(ctx: Context, request: CallRequest, ...options: readonly CallOption[]): Promise<Message>
}

/** Decodes and validates one Pricing request body. */
export function decodePricingRequest(bytes: Uint8Array): {
  readonly productId: string
  readonly currency: string
} {
  let value: unknown
  try {
    value = JSON.parse(jsonDecoder.decode(bytes))
  } catch {
    throw new TypeError("invalid Pricing.Get request")
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "productId") ||
    !Object.hasOwn(value, "currency")
  ) {
    throw new TypeError("invalid Pricing.Get request")
  }
  const productId = Reflect.get(value, "productId")
  const currency = Reflect.get(value, "currency")
  if (
    typeof productId !== "string" ||
    typeof currency !== "string" ||
    !isProductId(productId) ||
    !isSupportedCurrency(currency)
  ) {
    throw new TypeError("invalid Pricing.Get request")
  }
  return Object.freeze({ productId, currency })
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

/** Encodes one Pricing response into a transport Message. */
export function pricingResponseMessage(value: PriceQuote): Message {
  return Object.freeze({
    header: Object.freeze({ "Content-Type": jsonMediaType }),
    body: encodePrice(value)
  })
}

/** Encodes one Pricing request into a transport Message. */
function requestMessage(productId: string, currency: string): Message {
  return Object.freeze({
    header: Object.freeze({ "Content-Type": jsonMediaType }),
    body: jsonEncoder.encode(JSON.stringify({ productId, currency }))
  })
}

/** Calls Pricing with explicit idempotent retry authorization. */
export async function fetchPrice(
  ctx: Context,
  client: PricingClient,
  productId: string,
  currency: string
): Promise<PriceQuote | null> {
  const response = await client.call(
    ctx,
    {
      service: "pricing",
      endpoint: "Pricing.Get",
      message: requestMessage(productId, currency)
    },
    withFilter(filterVersion("v1")),
    withRetry({
      authorization: "idempotent",
      maxAttempts: 3,
      shouldRetry(_attemptContext, failure) {
        return failure instanceof TypeError
      },
      backoff: exponentialBackoff({ initialDelayMs: 10, maxDelayMs: 50 })
    })
  )
  return decodePrice(response.body, productId, currency)
}

export const pricingMediaType = jsonMediaType

/** Creates the Pricing.Get handler registered directly on a LikeGo Server. */
export function newPricingHandler(onCall?: () => void): Handler {
  return function pricing(_ctx: Context, message: Message): Message {
    const request = decodePricingRequest(message.body)
    const amountMinor = findAmountMinor(request.productId, request.currency)
    if (amountMinor === null) throw new TypeError("price is unavailable")
    onCall?.()
    return pricingResponseMessage(
      Object.freeze({
        productId: request.productId,
        currency: request.currency,
        amountMinor,
        validUntil: Date.now() + maximumCacheTtlMs
      })
    )
  }
}
