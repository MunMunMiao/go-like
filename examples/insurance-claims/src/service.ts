import type { Context } from "@go-like/context"
import type { Handler } from "@go-like/web"

import { newInsuranceClaimsHandler } from "./http"
import { newClaimsReviewWorker, type ClaimsWorker } from "./worker"

export interface PolicyDefinition {
  readonly policyId: string
  readonly startsAt: number
  readonly endsAt: number
  readonly deductibleCents: number
  readonly coverageLimitCents: number
}

export interface SubmitClaimCommand {
  readonly claimId: string
  readonly policyId: string
  readonly incidentAt: number
  readonly lossCents: number
}

export type ClaimStatus = "approved" | "belowDeductible" | "limitExhausted"

export interface ClaimDecision {
  readonly claimId: string
  readonly policyId: string
  readonly payableCents: number
  readonly remainingCoverageCents: number
  readonly status: ClaimStatus
}

export interface ClaimsRepository {
  submit(ctx: Context, command: SubmitClaimCommand): ClaimDecision
}

export type SubmitClaim = (ctx: Context, command: SubmitClaimCommand) => ClaimDecision

export interface InsuranceClaimsService {
  readonly handler: Handler
  readonly worker: ClaimsWorker
}

interface SavedClaim {
  readonly fingerprint: string
  readonly decision: ClaimDecision
}

/** Validates one policy loaded by the example repository. */
export function validatePolicy(policy: PolicyDefinition): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(policy.policyId)) {
    throw new TypeError("invalid policyId")
  }
  if (
    !Number.isSafeInteger(policy.startsAt) ||
    !Number.isSafeInteger(policy.endsAt) ||
    policy.startsAt >= policy.endsAt
  ) {
    throw new RangeError("invalid policy period")
  }
  if (
    !Number.isSafeInteger(policy.deductibleCents) ||
    policy.deductibleCents < 0 ||
    !Number.isSafeInteger(policy.coverageLimitCents) ||
    policy.coverageLimitCents <= 0
  ) {
    throw new RangeError("invalid policy money limits")
  }
}

/** Validates one claim submitted at the application trust boundary. */
export function validateClaim(command: SubmitClaimCommand): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
  if (!identifier.test(command.claimId)) throw new TypeError("invalid claimId")
  if (!identifier.test(command.policyId)) throw new TypeError("invalid policyId")
  if (!Number.isSafeInteger(command.incidentAt)) throw new RangeError("invalid incidentAt")
  if (!Number.isSafeInteger(command.lossCents) || command.lossCents <= 0) {
    throw new RangeError("lossCents must be a positive safe integer")
  }
}

/** Applies the policy period, deductible and remaining aggregate limit. */
export function decideClaim(
  command: SubmitClaimCommand,
  policy: PolicyDefinition,
  paidCents: number
): ClaimDecision {
  if (command.incidentAt < policy.startsAt || command.incidentAt >= policy.endsAt) {
    throw new Error("incident outside policy period")
  }
  if (!Number.isSafeInteger(paidCents) || paidCents < 0 || paidCents > policy.coverageLimitCents) {
    throw new RangeError("invalid paid aggregate")
  }
  const remainingBeforeClaim = policy.coverageLimitCents - paidCents
  const coveredLoss = Math.max(0, command.lossCents - policy.deductibleCents)
  const payableCents = Math.min(coveredLoss, remainingBeforeClaim)
  const status: ClaimStatus =
    remainingBeforeClaim === 0
      ? "limitExhausted"
      : payableCents === 0
        ? "belowDeductible"
        : "approved"
  return Object.freeze({
    claimId: command.claimId,
    policyId: command.policyId,
    payableCents,
    remainingCoverageCents: remainingBeforeClaim - payableCents,
    status
  })
}

function claimFingerprint(command: SubmitClaimCommand): string {
  return `${command.policyId}\u0000${command.incidentAt}\u0000${command.lossCents}`
}

/** Creates an in-memory policy repository with an atomic local paid aggregate. */
export function newMemoryClaimsRepository(
  policyDefinitions: readonly PolicyDefinition[]
): ClaimsRepository {
  const policies = new Map<string, PolicyDefinition>()
  const paidByPolicy = new Map<string, number>()
  const claims = new Map<string, SavedClaim>()
  for (const policy of policyDefinitions) {
    validatePolicy(policy)
    if (policies.has(policy.policyId)) throw new Error("duplicate policyId")
    policies.set(policy.policyId, policy)
    paidByPolicy.set(policy.policyId, 0)
  }

  return Object.freeze({
    submit(ctx: Context, command: SubmitClaimCommand): ClaimDecision {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = claimFingerprint(command)
      const saved = claims.get(command.claimId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("claim identity conflict")
        return saved.decision
      }
      const policy = policies.get(command.policyId)
      if (policy === undefined) throw new Error("unknown policy")
      const paidCents = paidByPolicy.get(command.policyId)
      if (paidCents === undefined) throw new Error("policy aggregate missing")
      const decision = decideClaim(command, policy, paidCents)
      paidByPolicy.set(command.policyId, paidCents + decision.payableCents)
      claims.set(command.claimId, Object.freeze({ fingerprint, decision }))
      return decision
    }
  })
}

/** Creates the insurance claim submission use case. */
export function newSubmitClaim(repository: ClaimsRepository): SubmitClaim {
  return function submitClaim(ctx: Context, command: SubmitClaimCommand): ClaimDecision {
    validateClaim(command)
    return repository.submit(ctx, command)
  }
}

/** Composes the claims handler with its structural review-worker resource. */
export function newInsuranceClaimsService(
  policies: readonly PolicyDefinition[]
): InsuranceClaimsService {
  const worker = newClaimsReviewWorker()
  const repository = newMemoryClaimsRepository(policies)
  return Object.freeze({
    handler: newInsuranceClaimsHandler(newSubmitClaim(repository)),
    worker
  })
}
