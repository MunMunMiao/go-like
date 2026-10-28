import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const pricingRequest = struct.object({
  productId: struct.string(),
  currency: struct.string()
})

const pricingQuote = struct.object({
  productId: struct.string(),
  currency: struct.string(),
  amountMinor: struct.number(),
  validUntil: struct.number()
})

/** Defines the internal pricing contract shared by Client and Server. */
export const pricing = defineService("pricing.v1", {
  get: {
    request: pricingRequest,
    response: pricingQuote
  }
})
