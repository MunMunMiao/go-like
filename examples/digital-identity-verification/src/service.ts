import type { Context } from "@likego/context"
import type { IdentityProviderGateway, IdentityVerificationRepository } from "./provider"

export type IdentityDecision = "verified" | "review" | "rejected"

export interface VerifyIdentityCommand {
  readonly requestId: string
  readonly applicantReference: string
  readonly providerId: string
  readonly documentDigest: string
}

export interface IdentityVerification {
  readonly requestId: string
  readonly applicantReference: string
  readonly providerId: string
  readonly decision: IdentityDecision
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const providerIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const documentDigest = /^[a-f0-9]{64}$/

/** Validates one provider identifier without revealing configured membership. */
export function validateProviderId(providerId: string): void {
  if (!providerIdentifier.test(providerId)) throw new TypeError("invalid providerId")
}

/** Validates the privacy-minimized identity command accepted by this service. */
export function validateIdentityCommand(command: VerifyIdentityCommand): void {
  if (!identifier.test(command.requestId)) throw new TypeError("invalid requestId")
  if (!identifier.test(command.applicantReference)) {
    throw new TypeError("invalid applicantReference")
  }
  validateProviderId(command.providerId)
  if (!documentDigest.test(command.documentDigest)) {
    throw new TypeError("documentDigest must be a lowercase SHA-256 digest")
  }
}

/** Produces an unambiguous fingerprint for idempotency conflict detection. */
export function identityCommandFingerprint(command: VerifyIdentityCommand): string {
  return `${command.applicantReference.length}:${command.applicantReference}${command.providerId.length}:${command.providerId}${command.documentDigest}`
}

export type VerifyIdentity = (
  ctx: Context,
  command: VerifyIdentityCommand
) => Promise<IdentityVerification>

/** Creates the idempotent identity-verification use case. */
export function newVerifyIdentity(
  repository: IdentityVerificationRepository,
  providers: IdentityProviderGateway
): VerifyIdentity {
  return async function verifyIdentity(
    ctx: Context,
    command: VerifyIdentityCommand
  ): Promise<IdentityVerification> {
    validateIdentityCommand(command)
    const fingerprint = identityCommandFingerprint(command)
    const saved = repository.get(ctx, command.requestId)
    if (saved !== null) {
      if (saved.fingerprint !== fingerprint) {
        throw new Error("identity request conflict")
      }
      return saved.verification
    }
    const decision = await providers.verify(ctx, command)
    return repository.save(
      ctx,
      command,
      Object.freeze({
        requestId: command.requestId,
        applicantReference: command.applicantReference,
        providerId: command.providerId,
        decision
      })
    )
  }
}
