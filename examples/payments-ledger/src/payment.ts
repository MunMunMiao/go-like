import { cause, type Context } from "@likego/context"
import type { PubAck } from "@nats-io/jetstream"

export const paymentSubject = "payments.ledger.v1.posted"
export const paymentStream = "PAYMENTS_LEDGER"

const requiredPaymentKeys = [
  "debitAccountId",
  "creditAccountId",
  "currency",
  "amountMinor",
  "reference"
] as const
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const amountPattern = /^[1-9][0-9]{0,18}$/u
const currencyPattern = /^[A-Z]{3}$/u
const maximumSignedBigInt = 9_223_372_036_854_775_807n

export interface PaymentRequest {
  readonly debitAccountId: string
  readonly creditAccountId: string
  readonly currency: string
  readonly amountMinor: string
  readonly reference: string
}

export interface PaymentEvent {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly transactionId: string
  readonly tenantId: string
  readonly currency: string
  readonly reference: string
  readonly postedAt: string
  readonly postings: readonly {
    readonly accountId: string
    readonly amountMinor: string
  }[]
}

export interface PaymentReceipt {
  readonly transactionId: string
  readonly eventId: string
  readonly replayed: boolean
}

export interface LedgerAccount {
  readonly tenantId: string
  readonly accountId: string
  readonly currency: string
}

export type OutboxPublishResult =
  | { readonly kind: "idle" }
  | {
      readonly kind: "published"
      readonly eventId: string
      readonly acknowledgement: PubAck
    }

export interface PaymentFailure extends Error {
  readonly code: "IDEMPOTENCY_CONFLICT" | "PAYMENT_VALIDATION"
}

/** Creates one stable application error without a class hierarchy. */
export function paymentFailure(code: PaymentFailure["code"], message: string): PaymentFailure {
  return Object.assign(new Error(message), { code })
}

/** Reports whether one unknown failure belongs to the public payment error contract. */
export function isPaymentFailure(value: unknown): value is PaymentFailure {
  if (!(value instanceof Error) || !("code" in value)) return false
  return value.code === "IDEMPOTENCY_CONFLICT" || value.code === "PAYMENT_VALIDATION"
}

/** Validates one bounded ledger identifier. */
export function requireIdentifier(label: string, value: string): void {
  if (!identifierPattern.test(value)) {
    throw paymentFailure("PAYMENT_VALIDATION", `${label} is invalid`)
  }
}

/** Rejects a canceled request before it can start a financial operation. */
export function requireActiveContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw cause(ctx) ?? failure
}

/** Validates one ISO-style three-letter ledger currency. */
export function requireCurrency(value: string): void {
  if (!currencyPattern.test(value)) {
    throw paymentFailure("PAYMENT_VALIDATION", "currency must be three uppercase letters")
  }
}

/** Parses the external payment body and enforces money-specific rules. */
export function parsePaymentRequest(value: unknown): PaymentRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw paymentFailure("PAYMENT_VALIDATION", "payment body must be an object")
  }
  for (const key of requiredPaymentKeys) {
    if (!Object.hasOwn(value, key)) {
      throw paymentFailure("PAYMENT_VALIDATION", `payment body is missing ${key}`)
    }
  }
  const debitAccountId = Reflect.get(value, "debitAccountId")
  const creditAccountId = Reflect.get(value, "creditAccountId")
  const currency = Reflect.get(value, "currency")
  const amountMinor = Reflect.get(value, "amountMinor")
  const reference = Reflect.get(value, "reference")
  if (
    typeof debitAccountId !== "string" ||
    typeof creditAccountId !== "string" ||
    typeof currency !== "string" ||
    typeof amountMinor !== "string" ||
    typeof reference !== "string"
  ) {
    throw paymentFailure("PAYMENT_VALIDATION", "payment body has invalid field types")
  }
  const request: PaymentRequest = {
    debitAccountId,
    creditAccountId,
    currency,
    amountMinor,
    reference
  }
  requireIdentifier("debitAccountId", request.debitAccountId)
  requireIdentifier("creditAccountId", request.creditAccountId)
  if (request.debitAccountId === request.creditAccountId) {
    throw paymentFailure("PAYMENT_VALIDATION", "ledger accounts must differ")
  }
  requireCurrency(request.currency)
  if (
    !amountPattern.test(request.amountMinor) ||
    BigInt(request.amountMinor) > maximumSignedBigInt
  ) {
    throw paymentFailure("PAYMENT_VALIDATION", "amountMinor is outside the signed bigint range")
  }
  if (request.reference.length === 0 || request.reference.length > 128) {
    throw paymentFailure("PAYMENT_VALIDATION", "reference length must be 1..128")
  }
  return Object.freeze(request)
}
