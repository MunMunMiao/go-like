import type { Context } from "@go-like/context"

export interface ChangeSubscriptionCommand {
  readonly requestId: string
  readonly subscriptionId: string
  readonly oldUnitPriceCents: number
  readonly newUnitPriceCents: number
  readonly quantity: number
  readonly periodStart: number
  readonly periodEnd: number
  readonly changedAt: number
}

export interface BillingAdjustment {
  readonly requestId: string
  readonly subscriptionId: string
  readonly amountCents: number
  readonly remainingMilliseconds: number
  readonly periodMilliseconds: number
}

export interface BillingAdjustmentRepository {
  record(ctx: Context, command: ChangeSubscriptionCommand): BillingAdjustment
}

export type ChangeSubscription = (
  ctx: Context,
  command: ChangeSubscriptionCommand
) => BillingAdjustment

interface SavedAdjustment {
  readonly fingerprint: string
  readonly adjustment: BillingAdjustment
}

/** Validates one mid-cycle subscription change at the application boundary. */
export function validateSubscriptionChange(command: ChangeSubscriptionCommand): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
  if (!identifier.test(command.requestId)) throw new TypeError("invalid requestId")
  if (!identifier.test(command.subscriptionId)) throw new TypeError("invalid subscriptionId")
  if (
    !Number.isSafeInteger(command.oldUnitPriceCents) ||
    command.oldUnitPriceCents < 0 ||
    !Number.isSafeInteger(command.newUnitPriceCents) ||
    command.newUnitPriceCents < 0
  ) {
    throw new RangeError("unit prices must be non-negative safe integers")
  }
  if (!Number.isSafeInteger(command.quantity) || command.quantity <= 0) {
    throw new RangeError("quantity must be a positive safe integer")
  }
  if (
    !Number.isSafeInteger(command.periodStart) ||
    !Number.isSafeInteger(command.periodEnd) ||
    !Number.isSafeInteger(command.changedAt) ||
    command.periodStart >= command.changedAt ||
    command.changedAt >= command.periodEnd
  ) {
    throw new RangeError("changedAt must be inside the billing period")
  }
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient
  const magnitude = remainder < 0n ? -remainder : remainder
  if (magnitude * 2n < denominator) return quotient
  return quotient + (numerator < 0n ? -1n : 1n)
}

/** Calculates one deterministic prorated adjustment using integer arithmetic. */
export function calculateBillingAdjustment(command: ChangeSubscriptionCommand): BillingAdjustment {
  const remainingMilliseconds = command.periodEnd - command.changedAt
  const periodMilliseconds = command.periodEnd - command.periodStart
  const unitDifference = BigInt(command.newUnitPriceCents - command.oldUnitPriceCents)
  const numerator = unitDifference * BigInt(command.quantity) * BigInt(remainingMilliseconds)
  const amountCents = Number(roundedRatio(numerator, BigInt(periodMilliseconds)))
  if (!Number.isSafeInteger(amountCents)) throw new RangeError("adjustment exceeds safe range")
  return Object.freeze({
    requestId: command.requestId,
    subscriptionId: command.subscriptionId,
    amountCents,
    remainingMilliseconds,
    periodMilliseconds
  })
}

/** Creates the stable identity used to detect conflicting request reuse. */
function subscriptionChangeFingerprint(command: ChangeSubscriptionCommand): string {
  return [
    command.subscriptionId,
    command.oldUnitPriceCents,
    command.newUnitPriceCents,
    command.quantity,
    command.periodStart,
    command.periodEnd,
    command.changedAt
  ].join("\u0000")
}

/** Creates an in-memory adjustment repository with request-level idempotency. */
export function newMemoryBillingAdjustmentRepository(): BillingAdjustmentRepository {
  const adjustments = new Map<string, SavedAdjustment>()
  return Object.freeze({
    record(ctx: Context, command: ChangeSubscriptionCommand): BillingAdjustment {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = subscriptionChangeFingerprint(command)
      const saved = adjustments.get(command.requestId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("idempotency conflict")
        return saved.adjustment
      }
      const adjustment = calculateBillingAdjustment(command)
      adjustments.set(command.requestId, Object.freeze({ fingerprint, adjustment }))
      return adjustment
    }
  })
}

/** Creates the use case for recording a prorated subscription change. */
export function newChangeSubscription(repository: BillingAdjustmentRepository): ChangeSubscription {
  return function changeSubscription(
    ctx: Context,
    command: ChangeSubscriptionCommand
  ): BillingAdjustment {
    validateSubscriptionChange(command)
    return repository.record(ctx, command)
  }
}
