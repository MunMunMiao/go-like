import { canceled, cause, withTimeoutCause, type Context } from "@likego/context"
import { newCircuitBreaker, type CircuitBreaker, type CircuitState } from "@likego/resilience"

import {
  identityCommandFingerprint,
  validateProviderId,
  type IdentityDecision,
  type IdentityVerification,
  type VerifyIdentityCommand
} from "./service"

export interface SavedIdentityVerification {
  readonly fingerprint: string
  readonly verification: IdentityVerification
}

export interface IdentityVerificationRepository {
  get(ctx: Context, requestId: string): SavedIdentityVerification | null
  save(
    ctx: Context,
    command: VerifyIdentityCommand,
    verification: IdentityVerification
  ): IdentityVerification
}

export interface IdentityProvider {
  readonly providerId: string
  verify(ctx: Context, command: VerifyIdentityCommand): Promise<IdentityDecision>
  ready(ctx: Context): Promise<void>
}

export interface MemoryIdentityProvider extends IdentityProvider {
  calls(): number
}

export interface MemoryIdentityProviderOptions {
  readonly providerId: string
  readonly decisionsByDigest: Readonly<Record<string, IdentityDecision>>
  readonly latencyMs?: number
  readonly available?: boolean
}

export interface IdentityProviderGateway {
  verify(ctx: Context, command: VerifyIdentityCommand): Promise<IdentityDecision>
  checkReady(ctx: Context, providerId: string): Promise<void>
  circuitState(providerId: string): CircuitState
}

export interface ResilientIdentityProviderOptions {
  readonly providers: readonly IdentityProvider[]
  readonly allowedProviderIds: readonly string[]
  readonly timeoutMs: number
  readonly failureThreshold?: number
}

/** Returns the exact cancellation carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  return cause(ctx) ?? ctx.err()
}

/** Rejects work admitted through a terminal Context. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Waits for simulated provider latency while honoring the request Context. */
function waitForContext(ctx: Context, delayMs: number): Promise<void> {
  checkContext(ctx)
  if (delayMs === 0) return Promise.resolve()
  return new Promise<void>(function wait(resolve, reject): void {
    const signal = ctx.done()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    /** Releases the owned timer and abort listener. */
    function cleanup(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener("abort", onAbort)
    }

    /** Resolves the latency wait once. */
    function finish(): void {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    /** Rejects the latency wait with the caller's exact Context outcome. */
    function onAbort(): void {
      if (settled) return
      settled = true
      cleanup()
      reject(contextFailure(ctx) ?? canceled)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    timer = setTimeout(finish, delayMs)
  })
}

/** Creates the process-local idempotency repository for verified outcomes. */
export function newMemoryIdentityVerificationRepository(): IdentityVerificationRepository {
  const savedByRequest = new Map<string, SavedIdentityVerification>()
  return Object.freeze({
    get(ctx: Context, requestId: string): SavedIdentityVerification | null {
      checkContext(ctx)
      return savedByRequest.get(requestId) ?? null
    },
    save(
      ctx: Context,
      command: VerifyIdentityCommand,
      verification: IdentityVerification
    ): IdentityVerification {
      checkContext(ctx)
      const fingerprint = identityCommandFingerprint(command)
      const saved = savedByRequest.get(command.requestId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("identity request conflict")
        return saved.verification
      }
      savedByRequest.set(command.requestId, Object.freeze({ fingerprint, verification }))
      return verification
    }
  })
}

/** Creates a provider stub that reads only the digest and never retains request payloads. */
export function newMemoryIdentityProvider(
  options: MemoryIdentityProviderOptions
): MemoryIdentityProvider {
  validateProviderId(options.providerId)
  const latencyMs = options.latencyMs ?? 0
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) {
    throw new RangeError("provider latencyMs must be a non-negative safe integer")
  }
  const decisions = new Map<string, IdentityDecision>()
  for (const [digest, decision] of Object.entries(options.decisionsByDigest)) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("invalid provider digest")
    if (decision !== "verified" && decision !== "review" && decision !== "rejected") {
      throw new TypeError("invalid provider decision")
    }
    decisions.set(digest, decision)
  }
  const available = options.available ?? true
  if (typeof available !== "boolean") {
    throw new TypeError("provider available must be boolean")
  }
  let calls = 0
  return Object.freeze({
    providerId: options.providerId,
    async verify(ctx: Context, command: VerifyIdentityCommand): Promise<IdentityDecision> {
      calls += 1
      await waitForContext(ctx, latencyMs)
      if (!available) throw new Error("identity provider unavailable")
      return decisions.get(command.documentDigest) ?? "review"
    },
    async ready(ctx: Context): Promise<void> {
      checkContext(ctx)
      if (!available) throw new Error("identity provider unavailable")
    },
    calls(): number {
      return calls
    }
  })
}

/** Composes provider allowlisting, per-provider timeout and isolated Circuit Breakers. */
export function newResilientIdentityProviderGateway(
  options: ResilientIdentityProviderOptions
): IdentityProviderGateway {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("provider timeoutMs must be a positive safe integer")
  }
  const failureThreshold = options.failureThreshold ?? 2
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
    throw new RangeError("provider failureThreshold must be a positive safe integer")
  }
  const providers = new Map<string, IdentityProvider>()
  for (const provider of options.providers) {
    validateProviderId(provider.providerId)
    if (providers.has(provider.providerId)) {
      throw new TypeError("duplicate identity provider")
    }
    providers.set(provider.providerId, provider)
  }
  if (options.allowedProviderIds.length === 0) {
    throw new TypeError("at least one identity provider must be allowed")
  }
  const allowed = new Set<string>()
  const breakers = new Map<string, CircuitBreaker>()
  for (const providerId of options.allowedProviderIds) {
    validateProviderId(providerId)
    if (allowed.has(providerId)) throw new TypeError("duplicate allowed provider")
    if (!providers.has(providerId)) throw new TypeError("allowed provider is not configured")
    allowed.add(providerId)
    breakers.set(
      providerId,
      newCircuitBreaker({
        failureThreshold,
        resetTimeoutMs: 30_000
      })
    )
  }

  /** Returns one admitted provider and breaker without exposing configuration membership. */
  function admitted(providerId: string): readonly [IdentityProvider, CircuitBreaker] {
    validateProviderId(providerId)
    const provider = allowed.has(providerId) ? providers.get(providerId) : undefined
    const breaker = allowed.has(providerId) ? breakers.get(providerId) : undefined
    if (provider === undefined || breaker === undefined) {
      throw new TypeError("identity provider is not allowed")
    }
    return Object.freeze([provider, breaker])
  }

  return Object.freeze({
    async verify(ctx: Context, command: VerifyIdentityCommand): Promise<IdentityDecision> {
      const selected = admitted(command.providerId)
      const timeoutCause = new Error("identity provider timed out")
      const timed = withTimeoutCause(ctx, options.timeoutMs, timeoutCause)
      try {
        return await selected[1].execute(
          timed[0],
          function verifyProvider(operationContext: Context): Promise<IdentityDecision> {
            return selected[0].verify(operationContext, command)
          }
        )
      } finally {
        timed[1]()
      }
    },
    checkReady(ctx: Context, providerId: string): Promise<void> {
      return admitted(providerId)[0].ready(ctx)
    },
    circuitState(providerId: string): CircuitState {
      return admitted(providerId)[1].snapshot().state
    }
  })
}
