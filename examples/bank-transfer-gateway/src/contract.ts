import { endpoint } from "@likego/transport"
import { jsonCodec } from "@likego/transport/json"

import type { TransferQuote, TransferQuoteCommand, TransferRail } from "./service"

const schemaVendor = "likego-example-bank-transfer-gateway"

interface ValidationIssue {
  readonly message: string
}

interface ValidationFailure {
  readonly issues: readonly ValidationIssue[]
}

/** Converts one rejected domain payload into a Standard Schema issue result. */
function validationFailure(error: unknown): ValidationFailure {
  return Object.freeze({
    issues: Object.freeze([
      Object.freeze({
        message: error instanceof Error ? error.message : "invalid transfer payload"
      })
    ])
  })
}

/** Validates an untrusted transfer quote request payload. */
export function transferQuoteCommandFrom(value: unknown): TransferQuoteCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  const sourceCountry: unknown = Reflect.get(value, "sourceCountry")
  const beneficiaryCountry: unknown = Reflect.get(value, "beneficiaryCountry")
  const currency: unknown = Reflect.get(value, "currency")
  const amountMinor: unknown = Reflect.get(value, "amountMinor")
  const rawBic: unknown = Reflect.get(value, "beneficiaryBic")
  if (
    typeof requestId !== "string" ||
    typeof sourceCountry !== "string" ||
    typeof beneficiaryCountry !== "string" ||
    typeof currency !== "string" ||
    typeof amountMinor !== "number" ||
    (rawBic !== undefined && rawBic !== null && typeof rawBic !== "string")
  ) {
    throw new TypeError("invalid transfer quote")
  }
  const beneficiaryBic = typeof rawBic === "string" ? rawBic : null
  return Object.freeze({
    requestId,
    sourceCountry,
    beneficiaryCountry,
    currency,
    amountMinor,
    beneficiaryBic
  })
}

/** Validates one internal quote response into its exact public contract. */
export function transferQuoteFrom(value: unknown): TransferQuote {
  if (value === null || typeof value !== "object") {
    throw new TypeError("invalid transfer quote response")
  }
  const requestId: unknown = Reflect.get(value, "requestId")
  const rail: unknown = Reflect.get(value, "rail")
  const feeMinor: unknown = Reflect.get(value, "feeMinor")
  const settlementBusinessDays: unknown = Reflect.get(value, "settlementBusinessDays")
  if (
    typeof requestId !== "string" ||
    (rail !== "domestic" && rail !== "sepa" && rail !== "swift") ||
    typeof feeMinor !== "number" ||
    !Number.isSafeInteger(feeMinor) ||
    feeMinor < 0 ||
    typeof settlementBusinessDays !== "number" ||
    !Number.isSafeInteger(settlementBusinessDays) ||
    settlementBusinessDays < 0
  ) {
    throw new TypeError("invalid transfer quote response")
  }
  const selectedRail: TransferRail = rail
  return Object.freeze({
    requestId,
    rail: selectedRail,
    feeMinor,
    settlementBusinessDays
  })
}

const transferQuoteCommandCodec = jsonCodec<TransferQuoteCommand>({
  "~standard": Object.freeze({
    version: 1,
    vendor: schemaVendor,
    validate(value: unknown) {
      try {
        return Object.freeze({ value: transferQuoteCommandFrom(value) })
      } catch (error) {
        return validationFailure(error)
      }
    }
  })
})

const transferQuoteCodec = jsonCodec<TransferQuote>({
  "~standard": Object.freeze({
    version: 1,
    vendor: schemaVendor,
    validate(value: unknown) {
      try {
        return Object.freeze({ value: transferQuoteFrom(value) })
      } catch (error) {
        return validationFailure(error)
      }
    }
  })
})

/** Defines the typed internal unary contract shared by the Client and Server. */
export const transferQuoteEndpoint = endpoint(
  "bank-transfer-routing",
  "TransferRouting.Quote",
  transferQuoteCommandCodec,
  transferQuoteCodec
)
