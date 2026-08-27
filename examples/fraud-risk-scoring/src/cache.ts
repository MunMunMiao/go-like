import { expiresIn, type Cache } from "@go-like/cache"
import { newMemoryCache, type MemoryCache } from "@go-like/cache-memory"
import type { Context } from "@go-like/context"
import { newCircuitBreaker, type CircuitBreaker } from "@go-like/resilience"

import {
  newAssessTransaction,
  newMemoryFraudSignalsRepository,
  transactionFingerprint,
  validateTransaction,
  type AssessTransactionCommand,
  type AssessTransaction,
  type RiskAssessment,
  type RiskDecision,
  type VelocitySignals
} from "./service"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface CachedAssessment {
  readonly fingerprint: string
  readonly assessment: RiskAssessment
}

export type CachedAssessTransaction = (
  ctx: Context,
  command: AssessTransactionCommand
) => Promise<RiskAssessment>

export interface FraudRiskMicroservice {
  readonly cache: MemoryCache
  readonly breaker: CircuitBreaker
  readonly assess: CachedAssessTransaction
}

/** Recognizes one exact public risk decision. */
function riskDecisionFrom(value: unknown): RiskDecision | null {
  return value === "approve" || value === "review" || value === "decline" ? value : null
}

/** Decodes one cache entry without trusting persisted JSON. */
function cachedAssessmentFrom(bytes: Uint8Array): CachedAssessment | null {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    return null
  }
  if (value === null || typeof value !== "object") return null
  const fingerprint: unknown = Reflect.get(value, "fingerprint")
  const rawAssessment: unknown = Reflect.get(value, "assessment")
  if (
    typeof fingerprint !== "string" ||
    rawAssessment === null ||
    typeof rawAssessment !== "object"
  ) {
    return null
  }
  const transactionId: unknown = Reflect.get(rawAssessment, "transactionId")
  const score: unknown = Reflect.get(rawAssessment, "score")
  const rawDecision: unknown = Reflect.get(rawAssessment, "decision")
  const rawReasons: unknown = Reflect.get(rawAssessment, "reasons")
  const decision = riskDecisionFrom(rawDecision)
  if (
    typeof transactionId !== "string" ||
    typeof score !== "number" ||
    !Number.isSafeInteger(score) ||
    score < 0 ||
    score > 100 ||
    decision === null ||
    !Array.isArray(rawReasons)
  ) {
    return null
  }
  const reasons: string[] = []
  for (const reason of rawReasons) {
    if (typeof reason !== "string") return null
    reasons.push(reason)
  }
  return Object.freeze({
    fingerprint,
    assessment: Object.freeze({
      transactionId,
      score,
      decision,
      reasons: Object.freeze(reasons)
    })
  })
}

/** Encodes one trusted assessment and its request fingerprint for the Cache. */
function encodeCachedAssessment(value: CachedAssessment): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

/** Builds the stable Cache key for one validated transaction identity. */
function assessmentKey(transactionId: string): string {
  return `fraud-assessment:v1:${transactionId}`
}

/** Wraps risk computation with a real Cache hit path and Circuit Breaker admission. */
export function newCachedAssessTransaction(
  cache: Cache,
  breaker: CircuitBreaker,
  assess: AssessTransaction,
  ttlMs = 60_000
): CachedAssessTransaction {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError("fraud assessment cache ttl must be a positive safe integer")
  }
  return async function cachedAssessTransaction(
    ctx: Context,
    command: AssessTransactionCommand
  ): Promise<RiskAssessment> {
    validateTransaction(command)
    const fingerprint = transactionFingerprint(command)
    const key = assessmentKey(command.transactionId)
    const bytes = await cache.get(ctx, key)
    const cached = bytes === null ? null : cachedAssessmentFrom(bytes)
    if (cached !== null) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error("transaction identity conflict")
      }
      return cached.assessment
    }
    const assessment = await breaker.execute(
      ctx,
      function calculate(operationContext: Context): RiskAssessment {
        return assess(operationContext, command)
      }
    )
    await cache.put(
      ctx,
      key,
      encodeCachedAssessment(Object.freeze({ fingerprint, assessment })),
      expiresIn(ttlMs)
    )
    return assessment
  }
}

/** Composes memory Cache and Circuit Breaker around the fraud scoring use case. */
export function newFraudRiskMicroservice(
  signalsByAccount: Readonly<Record<string, VelocitySignals>>
): FraudRiskMicroservice {
  const cache = newMemoryCache()
  const breaker = newCircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 1_000
  })
  const assess = newAssessTransaction(newMemoryFraudSignalsRepository(signalsByAccount))
  return Object.freeze({
    cache,
    breaker,
    assess: newCachedAssessTransaction(cache, breaker, assess)
  })
}
