import { struct, type Infer } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const transferQuoteCommand = struct.object({
  requestId: struct.string(),
  sourceCountry: struct.string(),
  beneficiaryCountry: struct.string(),
  currency: struct.string(),
  amountMinor: struct.number(),
  beneficiaryBic: struct.string().nullish()
})
export type TransferQuoteCommand = Infer<typeof transferQuoteCommand>

const transferQuote = struct.object({
  requestId: struct.string(),
  rail: struct.enum(["domestic", "sepa", "swift"]),
  feeMinor: struct.number(),
  settlementBusinessDays: struct.number()
})
export type TransferQuote = Infer<typeof transferQuote>

/** Defines the internal bank-transfer quote contract shared by Client and Server. */
export const bankTransfer = defineService("bank-transfer-routing.v1", {
  quote: {
    request: transferQuoteCommand,
    response: transferQuote
  }
})

/** Exposes the quote endpoint used by the public JSON boundary. */
export const transferQuoteEndpoint = bankTransfer.endpoints.quote
