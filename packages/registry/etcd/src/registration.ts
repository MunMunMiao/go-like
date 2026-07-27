import { background, type Context } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { notifyRegistrationError, snapshotServiceInstance } from "@likego/registry/provider"

import { encodeRecord, registrationIdentity, type EncodedRecord } from "./codec"
import { boundaryError, rollbackFailure } from "./errors"
import { retryable } from "./http"
import type { OperationOptions } from "./options"
import { grantLease, keepAlive, owns, publish, remove, restore, revokeLease } from "./protocol"
import { completion, contextFailure, ignoreFailure, operationLease, waitForSignal } from "./runtime"

interface IdentityState {
  tail: Promise<void>
  active: ActiveRegistration | null
  refs: number
}

interface ActiveRegistration {
  readonly wire: EncodedRecord
  readonly options: OperationOptions
  readonly ttlMs: number
  readonly ttlSeconds: number
  readonly owner: AbortController
  lease: string
}

interface LockRelease {
  /** Releases one acquired identity serializer. */
  (): void
}

/** Owns private etcd leases behind the provider-neutral Registrar API. */
export interface RegistrationManager {
  /** Reports retained identity serializers to relative-path tests only. */
  identityCount(): number
  /** Registers one immutable ServiceInstance and starts its private lease renewal. */
  register(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
  /** Deregisters one ServiceInstance and stops its private lease renewal. */
  deregister(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
}

/** Acquires one FIFO identity serializer and returns its idempotent release. */
async function acquire(
  identities: Map<string, IdentityState>,
  identity: string,
  state: IdentityState
): Promise<LockRelease> {
  const gate = completion()
  state.refs += 1
  const previous = state.tail
  state.tail = previous.then(
    /** Joins the newly captured queue gate after the prior owner. */
    function join(): Promise<void> {
      return gate.promise
    }
  )
  await previous
  let released = false
  /** Releases this exact queue position once. */
  function release(): void {
    if (released) return
    released = true
    state.refs -= 1
    gate.resolve()
    if (state.active === null && state.refs === 0 && identities.get(identity) === state) {
      identities.delete(identity)
    }
  }
  return release
}

/** Reports one private lease failure without changing a completed public operation. */
function report(options: OperationOptions, level: "warn" | "error", error: Error): void {
  try {
    options.common.logger?.log(level, "etcd registration lease renewal failed", {
      code: "code" in error ? error.code : undefined,
      name: error.name
    })
  } catch {
    // Borrowed diagnostic sinks cannot control provider state.
  }
}

/** Revokes one private lease best effort. */
async function retire(options: OperationOptions, leaseId: string): Promise<void> {
  const operation = operationLease(background(), null, options.timeoutMs)
  try {
    await revokeLease(options, leaseId, operation.signal)
  } catch (value) {
    ignoreFailure(value)
  } finally {
    operation.release()
  }
}

/** Grants and publishes one record while cleaning an unaccepted lease. */
async function admit(
  ctx: Context,
  options: OperationOptions,
  wire: EncodedRecord,
  ttlSeconds: number
): Promise<string> {
  const operation = operationLease(ctx, null, options.timeoutMs)
  let leaseId: string | null = null
  let accepted = false
  try {
    leaseId = await grantLease(options, ttlSeconds, operation.signal)
    await publish(options, wire, leaseId, operation.signal)
    accepted = true
    return leaseId
  } finally {
    operation.release()
    if (!accepted && leaseId !== null) await retire(options, leaseId)
  }
}

/** Restores one previous local registration after a failed same-key replacement. */
async function restorePrevious(previous: ActiveRegistration): Promise<void> {
  const operation = operationLease(background(), previous.owner.signal, previous.options.timeoutMs)
  try {
    await publish(previous.options, previous.wire, previous.lease, operation.signal)
  } finally {
    operation.release()
  }
}

/** Creates a registration manager with one private lease owner per logical instance. */
export function newRegistrationManager(): RegistrationManager {
  const identities = new Map<string, IdentityState>()

  /** Returns the stable local state for one deterministic identity. */
  function identityState(identity: string): IdentityState {
    const found = identities.get(identity)
    if (found !== undefined) return found
    const created: IdentityState = { tail: Promise.resolve(), active: null, refs: 0 }
    identities.set(identity, created)
    return created
  }

  /** Restores one expired current record under a fresh lease. */
  async function restoreExpired(registration: ActiveRegistration): Promise<boolean> {
    const operation = operationLease(
      background(),
      registration.owner.signal,
      registration.options.timeoutMs
    )
    let leaseId: string | null = null
    let accepted = false
    try {
      leaseId = await grantLease(registration.options, registration.ttlSeconds, operation.signal)
      accepted = await restore(registration.options, registration.wire, leaseId, operation.signal)
      if (accepted) registration.lease = leaseId
      return accepted
    } finally {
      operation.release()
      if (!accepted && leaseId !== null) await retire(registration.options, leaseId)
    }
  }

  /** Runs one retrying private lease heartbeat for the current generation only. */
  async function heartbeatLoop(
    state: IdentityState,
    registration: ActiveRegistration
  ): Promise<void> {
    let delayMs = Math.floor(registration.ttlMs / 2)
    while (!registration.owner.signal.aborted) {
      try {
        await waitForSignal(registration.owner.signal, delayMs)
      } catch {
        return
      }
      const release = await acquire(identities, registration.wire.identity, state)
      try {
        if (state.active !== registration || registration.owner.signal.aborted) return
        try {
          const operation = operationLease(
            background(),
            registration.owner.signal,
            registration.options.timeoutMs
          )
          let alive = false
          try {
            alive = await keepAlive(registration.options, registration.lease, operation.signal)
            if (alive) {
              alive = await owns(
                registration.options,
                registration.wire,
                registration.lease,
                operation.signal
              )
            }
          } finally {
            operation.release()
          }
          if (!alive && !(await restoreExpired(registration))) {
            const error = new Error("etcd registration ownership was replaced")
            state.active = null
            registration.owner.abort(error)
            notifyRegistrationError(
              registration.options.common.onRegistrationError,
              error,
              registration.wire.instance
            )
            return
          }
          delayMs = Math.floor(registration.ttlMs / 2)
        } catch (value) {
          const error = boundaryError(
            value,
            "etcd private lease renewal rejected with a non-Error value"
          )
          if (!retryable(error)) {
            state.active = null
            registration.owner.abort(error)
            report(registration.options, "error", error)
            notifyRegistrationError(
              registration.options.common.onRegistrationError,
              error,
              registration.wire.instance
            )
            return
          }
          report(registration.options, "warn", error)
          delayMs = Math.min(
            registration.options.retryMaximumMs,
            Math.max(registration.options.retryInitialMs, Math.floor(delayMs / 2))
          )
        }
      } finally {
        release()
      }
    }
  }

  return Object.freeze({
    /** Reports retained identity serializers without joining the package API. */
    identityCount(): number {
      return identities.size
    },
    /** Registers or replaces one instance without exposing private ownership handles. */
    async register(ctx: Context, value: ServiceInstance, options: OperationOptions): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const instance = snapshotServiceInstance(value)
      const wire = await encodeRecord(options.prefix, instance)
      const state = identityState(wire.identity)
      const release = await acquire(identities, wire.identity, state)
      let leaseId: string | null = null
      try {
        const previous = state.active
        try {
          leaseId = await admit(ctx, options, wire, Math.ceil(options.ttlMs / 1_000))
          const finalFailure = contextFailure(ctx)
          if (finalFailure !== null) throw finalFailure
        } catch (value) {
          const primary =
            contextFailure(ctx) ??
            boundaryError(value, "etcd registration rejected with a non-Error value")
          if (leaseId === null) throw primary
          const failures: Error[] = []
          try {
            if (previous !== null) {
              await restorePrevious(previous)
            } else {
              const cleanup = operationLease(background(), null, options.timeoutMs)
              try {
                await remove(options, wire, cleanup.signal)
              } finally {
                cleanup.release()
              }
            }
          } catch (rollbackValue) {
            failures.push(
              boundaryError(
                rollbackValue,
                "etcd registration rollback rejected with a non-Error value"
              )
            )
          }
          await retire(options, leaseId)
          throw rollbackFailure(primary, failures)
        }
        if (leaseId === null) throw new Error("etcd registration lease admission omitted its lease")
        previous?.owner.abort(new Error("etcd registration was replaced"))
        if (previous !== null) await retire(previous.options, previous.lease)
        const owner = new AbortController()
        const registration: ActiveRegistration = {
          wire,
          options,
          ttlMs: options.ttlMs,
          ttlSeconds: Math.ceil(options.ttlMs / 1_000),
          owner,
          lease: leaseId
        }
        state.active = registration
        void heartbeatLoop(state, registration).catch(ignoreFailure)
      } finally {
        release()
      }
    },
    /** Deregisters the deterministic instance identity and stops private renewal. */
    async deregister(
      ctx: Context,
      value: ServiceInstance,
      options: OperationOptions
    ): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const instance = snapshotServiceInstance(value)
      const identity = await registrationIdentity(instance)
      const state = identityState(identity)
      const release = await acquire(identities, identity, state)
      try {
        const active = state.active
        const effective = active?.options ?? options
        const wire = active?.wire ?? (await encodeRecord(effective.prefix, instance))
        const operation = operationLease(ctx, null, effective.timeoutMs)
        try {
          await remove(effective, wire, operation.signal)
        } finally {
          operation.release()
        }
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        if (active !== null) {
          active.owner.abort(new Error("etcd registration was deregistered"))
          state.active = null
          await retire(active.options, active.lease)
        }
      } finally {
        release()
      }
    }
  })
}
