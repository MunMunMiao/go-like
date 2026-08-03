import { struct, type Infer } from "@likego/struct"
import { endpoint } from "@likego/transport"

const transferQuoteCommand = struct.object({
  requestId: struct.string(),
  sourceCountry: struct.string(),
  beneficiaryCountry: struct.string(),
  currency: struct.string(),
  amountMinor: struct.number(),
  beneficiaryBic: struct.string().null()
})
export type TransferQuoteCommand = Infer<typeof transferQuoteCommand>

const transferQuote = struct.object({
  requestId: struct.string(),
  rail: struct.enum(["domestic", "sepa", "swift"]),
  feeMinor: struct.number(),
  settlementBusinessDays: struct.number()
})
export type TransferQuote = Infer<typeof transferQuote>

/** Defines the typed internal unary contract shared by the Client and Server. */
export const transferQuoteEndpoint = endpoint(
  "bank-transfer-routing",
  "TransferRouting.Quote",
  transferQuoteCommand,
  transferQuote
)
