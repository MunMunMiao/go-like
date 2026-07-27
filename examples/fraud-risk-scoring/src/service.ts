import type { Context } from "@likego/context"

export interface AssessTransactionCommand {
  readonly transactionId: string
  readonly accountId: string
  readonly amountMinor: number
  readonly country: string
  readonly homeCountry: string
  readonly deviceTrusted: boolean
}

export interface VelocitySignals {
  readonly transactionsLastFiveMinutes: number
  readonly declinedLastHour: number
}

export type RiskDecision = "approve" | "review" | "decline"

export interface RiskAssessment {
  readonly transactionId: string
  readonly score: number
  readonly decision: RiskDecision
  readonly reasons: readonly string[]
}

export interface SavedAssessment {
  readonly fingerprint: string
  readonly assessment: RiskAssessment
}

export interface FraudSignalsRepository {
  signals(ctx: Context, accountId: string): VelocitySignals
  find(ctx: Context, transactionId: string): SavedAssessment | null
  save(ctx: Context, transactionId: string, fingerprint: string, assessment: RiskAssessment): void
}

export type AssessTransaction = (ctx: Context, command: AssessTransactionCommand) => RiskAssessment

const emptySignals = Object.freeze({
  transactionsLastFiveMinutes: 0,
  declinedLastHour: 0
})

/** Validates the transaction facts accepted from the request boundary. */
export function validateTransaction(command: AssessTransactionCommand): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
  if (!identifier.test(command.transactionId)) throw new TypeError("invalid transactionId")
  if (!identifier.test(command.accountId)) throw new TypeError("invalid accountId")
  if (
    !Number.isSafeInteger(command.amountMinor) ||
    command.amountMinor <= 0 ||
    command.amountMinor > 1_000_000_000_000
  ) {
    throw new RangeError("amountMinor is outside the supported range")
  }
  if (!/^[A-Z]{2}$/.test(command.country)) throw new TypeError("invalid country")
  if (!/^[A-Z]{2}$/.test(command.homeCountry)) throw new TypeError("invalid homeCountry")
}

function validateSignals(signals: VelocitySignals): void {
  if (
    !Number.isSafeInteger(signals.transactionsLastFiveMinutes) ||
    signals.transactionsLastFiveMinutes < 0 ||
    !Number.isSafeInteger(signals.declinedLastHour) ||
    signals.declinedLastHour < 0
  ) {
    throw new RangeError("invalid server-side velocity signals")
  }
}

/** Produces a bounded and explainable rules-based fraud assessment. */
export function scoreTransaction(
  command: AssessTransactionCommand,
  signals: VelocitySignals
): RiskAssessment {
  validateSignals(signals)
  let score = 0
  const reasons: string[] = []
  if (command.amountMinor >= 100_000) {
    score += 25
    reasons.push("high_amount")
  }
  if (command.country !== command.homeCountry) {
    score += 25
    reasons.push("country_mismatch")
  }
  if (!command.deviceTrusted) {
    score += 20
    reasons.push("untrusted_device")
  }
  if (signals.transactionsLastFiveMinutes >= 4) {
    score += 30
    reasons.push("velocity_spike")
  }
  if (signals.declinedLastHour >= 2) {
    score += 25
    reasons.push("recent_declines")
  }
  const boundedScore = Math.min(100, score)
  const decision: RiskDecision =
    boundedScore >= 70 ? "decline" : boundedScore >= 40 ? "review" : "approve"
  return Object.freeze({
    transactionId: command.transactionId,
    score: boundedScore,
    decision,
    reasons: Object.freeze(reasons)
  })
}

/** Creates the stable identity used to detect conflicting transaction reuse. */
export function transactionFingerprint(command: AssessTransactionCommand): string {
  return [
    command.accountId,
    command.amountMinor,
    command.country,
    command.homeCountry,
    command.deviceTrusted
  ].join("\u0000")
}

/** Creates an in-memory source for trusted velocity signals and assessments. */
export function newMemoryFraudSignalsRepository(
  signalsByAccount: Readonly<Record<string, VelocitySignals>>
): FraudSignalsRepository {
  const signalsByAccountId = new Map<string, VelocitySignals>()
  const assessments = new Map<string, SavedAssessment>()
  for (const [accountId, signals] of Object.entries(signalsByAccount)) {
    signalsByAccountId.set(accountId, signals)
  }
  return Object.freeze({
    signals(ctx: Context, accountId: string): VelocitySignals {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return signalsByAccountId.get(accountId) ?? emptySignals
    },
    find(ctx: Context, transactionId: string): SavedAssessment | null {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return assessments.get(transactionId) ?? null
    },
    save(
      ctx: Context,
      transactionId: string,
      fingerprint: string,
      assessment: RiskAssessment
    ): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      assessments.set(transactionId, Object.freeze({ fingerprint, assessment }))
    }
  })
}

/** Creates the fraud assessment use case from trusted server-side signals. */
export function newAssessTransaction(repository: FraudSignalsRepository): AssessTransaction {
  return function assessTransaction(
    ctx: Context,
    command: AssessTransactionCommand
  ): RiskAssessment {
    validateTransaction(command)
    const fingerprint = transactionFingerprint(command)
    const saved = repository.find(ctx, command.transactionId)
    if (saved !== null) {
      if (saved.fingerprint !== fingerprint) throw new Error("transaction identity conflict")
      return saved.assessment
    }
    const assessment = scoreTransaction(command, repository.signals(ctx, command.accountId))
    repository.save(ctx, command.transactionId, fingerprint, assessment)
    return assessment
  }
}
