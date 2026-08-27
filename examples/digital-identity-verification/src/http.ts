import type { Context } from "@go-like/context"
import { newProbeRegistry, type ProbeRegistry } from "@go-like/health"
import type { CircuitState } from "@go-like/resilience"
import { contextHandler, type Handler } from "@go-like/web"
import { createHealthHandler } from "@go-like/web/health"

import { newVerifyIdentity, type VerifyIdentity, type VerifyIdentityCommand } from "./service"
import {
  newMemoryIdentityVerificationRepository,
  newResilientIdentityProviderGateway,
  type IdentityProvider
} from "./provider"

/** Decodes only the privacy-minimized public identity command. */
function commandFrom(value: unknown): VerifyIdentityCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid JSON body")
  }
  const requestId: unknown = Reflect.get(value, "requestId")
  const applicantReference: unknown = Reflect.get(value, "applicantReference")
  const providerId: unknown = Reflect.get(value, "providerId")
  const documentDigest: unknown = Reflect.get(value, "documentDigest")
  if (
    typeof requestId !== "string" ||
    typeof applicantReference !== "string" ||
    typeof providerId !== "string" ||
    typeof documentDigest !== "string"
  ) {
    throw new TypeError("invalid identity verification command")
  }
  return Object.freeze({
    requestId,
    applicantReference,
    providerId,
    documentDigest
  })
}

/** Creates the standard Fetch endpoint without logging or echoing document evidence. */
export function newIdentityVerificationHandler(verifyIdentity: VerifyIdentity): Handler {
  return contextHandler(async function identityVerificationHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/v1/identity-verifications"
    ) {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await verifyIdentity(ctx, commandFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "identity verification failed"
      const status =
        error instanceof TypeError || error instanceof RangeError
          ? 400
          : message === "identity request conflict"
            ? 409
            : 503
      return Response.json({ code: "identity_verification_rejected", message }, { status })
    }
  })
}

export interface DigitalIdentityServiceOptions {
  readonly providers: readonly IdentityProvider[]
  readonly allowedProviderIds: readonly string[]
  readonly timeoutMs: number
  readonly failureThreshold?: number
}

export interface DigitalIdentityService {
  readonly handler: Handler
  readonly health: Handler
  readonly probes: ProbeRegistry
  readonly circuitState: (providerId: string) => CircuitState
}

/** Rejects health work admitted from a terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Composes privacy-minimized verification, resilience and provider readiness. */
export function newDigitalIdentityService(
  options: DigitalIdentityServiceOptions
): DigitalIdentityService {
  const gateway = newResilientIdentityProviderGateway(options)
  const probes = newProbeRegistry()
  probes.register("live", "identity-runtime", checkContext)
  for (const providerId of options.allowedProviderIds) {
    probes.register(
      "ready",
      `identity-provider-${providerId}`,
      function providerReady(ctx: Context): Promise<void> {
        return gateway.checkReady(ctx, providerId)
      }
    )
  }
  return Object.freeze({
    handler: newIdentityVerificationHandler(
      newVerifyIdentity(newMemoryIdentityVerificationRepository(), gateway)
    ),
    health: createHealthHandler(probes),
    probes,
    circuitState: gateway.circuitState
  })
}
