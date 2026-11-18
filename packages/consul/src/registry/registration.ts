import { background, type Context } from "@go-like/core/context"
import type { ServiceInstance } from "@go-like/core/registry"
import {
  newIdentityLocks,
  startHeartbeat,
  type Heartbeat,
  type IdentityLocks
} from "@go-like/core/registry/provider"
import { snapshotServiceInstance } from "@go-like/core/registry"

import {
  decodeAgentReadback,
  encodeRegistration,
  registrationIdentity,
  type EncodedRegistration
} from "./codec"
import { mutate } from "../client/agent"
import { boundaryError } from "../client/errors"
import { queryText } from "../client/health"
import { consulUrl, retryable } from "../client/http"
import { rollbackFailure } from "./errors"
import type { OperationOptions } from "./options"
import { contextFailure, operationLease } from "./runtime"

interface IdentityState {
  active: ActiveRegistration | null
  refs: number
}

interface ActiveRegistration {
  readonly wire: EncodedRegistration
  readonly options: OperationOptions
  readonly ttlMs: number
  readonly owner: AbortController
  heartbeat: Heartbeat | null
}

interface LockRelease {
  /** Releases one acquired identity serializer. */
  (): void
}

/** Owns private TTL heartbeats behind the provider-neutral Registrar API. */
export interface RegistrationManager {
  /** Reports retained identity serializers to relative-path tests only. */
  identityCount(): number
  /** Registers one immutable ServiceInstance and starts its private heartbeat. */
  register(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
  /** Deregisters one ServiceInstance and stops its private heartbeat. */
  deregister(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
}

/** Acquires one shared identity lock and drops idle state after the last release. */
async function acquire(
  locks: IdentityLocks,
  identities: Map<string, IdentityState>,
  identity: string,
  state: IdentityState
): Promise<LockRelease> {
  state.refs += 1
  let releaseLock: () => void
  try {
    releaseLock = await locks.acquire(background(), identity)
  } catch (error) {
    state.refs -= 1
    if (state.active === null && state.refs === 0 && identities.get(identity) === state) {
      identities.delete(identity)
    }
    throw error
  }
  let released = false
  /** Releases this exact queue position once. */
  function release(): void {
    if (released) return
    released = true
    state.refs -= 1
    releaseLock()
    if (state.active === null && state.refs === 0 && identities.get(identity) === state) {
      identities.delete(identity)
    }
  }
  return release
}

/** Creates the scoped exact Agent service URL for one remote ID. */
function serviceUrl(options: OperationOptions, remoteId: string): URL {
  return consulUrl(options, `/v1/agent/service/${encodeURIComponent(remoteId)}`, false)
}

/** Creates the shared Agent registration URL. */
function registerUrl(options: OperationOptions): URL {
  const url = consulUrl(options, "/v1/agent/service/register", false)
  url.searchParams.set("replace-existing-checks", "true")
  return url
}

/** Creates the exact Agent deregistration URL. */
function deregisterUrl(options: OperationOptions, remoteId: string): URL {
  return consulUrl(options, `/v1/agent/service/deregister/${encodeURIComponent(remoteId)}`, false)
}

/** Creates the exact TTL pass URL. */
function heartbeatUrl(options: OperationOptions, remoteId: string): URL {
  return consulUrl(
    options,
    `/v1/agent/check/pass/${encodeURIComponent(`service:${remoteId}`)}`,
    false
  )
}

/** Reads back whether one exact managed record exists. */
async function registered(
  options: OperationOptions,
  record: EncodedRegistration,
  owner: AbortSignal | null
): Promise<boolean> {
  const lease = operationLease(background(), owner, options.timeoutMs)
  try {
    const result = await queryText(
      options,
      "readback",
      serviceUrl(options, record.remoteId),
      lease.signal,
      true
    )
    return result[2] === 404 ? false : decodeAgentReadback(result[0], record)
  } finally {
    lease.release()
  }
}

/** Reads back whether any record exists for one deterministic remote ID. */
async function exists(
  options: OperationOptions,
  remoteId: string,
  owner: AbortSignal | null
): Promise<boolean> {
  const lease = operationLease(background(), owner, options.timeoutMs)
  try {
    const result = await queryText(
      options,
      "readback",
      serviceUrl(options, remoteId),
      lease.signal,
      true
    )
    return result[2] !== 404
  } finally {
    lease.release()
  }
}

/** Reads one Agent check table and verifies the exact TTL check is passing. */
async function passing(
  options: OperationOptions,
  record: EncodedRegistration,
  owner: AbortSignal | null
): Promise<boolean> {
  const lease = operationLease(background(), owner, options.timeoutMs)
  try {
    const result = await queryText(
      options,
      "readback",
      consulUrl(options, "/v1/agent/checks", false),
      lease.signal,
      false
    )
    let value: unknown
    try {
      value = JSON.parse(result[0])
    } catch {
      return false
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const check = Object.getOwnPropertyDescriptor(value, `service:${record.remoteId}`)?.value
    if (typeof check !== "object" || check === null || Array.isArray(check)) return false
    return Object.getOwnPropertyDescriptor(check, "Status")?.value === "passing"
  } finally {
    lease.release()
  }
}

/** Registers one exact record and resolves an ambiguous response by readback. */
async function put(
  ctx: Context,
  options: OperationOptions,
  record: EncodedRegistration,
  owner: AbortSignal | null = null
): Promise<void> {
  const lease = operationLease(ctx, owner, options.timeoutMs)
  try {
    await mutate(options, "register", registerUrl(options), record.body, lease.signal, false)
  } catch (value) {
    const primary = boundaryError(value, "Consul register rejected with a non-Error value")
    if (retryable(primary) && (await registered(options, record, owner))) return
    throw primary
  } finally {
    lease.release()
  }
}

/** Passes one exact TTL check and recreates a record forgotten by the Agent. */
async function pass(
  ctx: Context,
  options: OperationOptions,
  record: EncodedRegistration,
  owner: AbortSignal | null = null
): Promise<void> {
  const lease = operationLease(ctx, owner, options.timeoutMs)
  try {
    const result = await mutate(
      options,
      "heartbeat",
      heartbeatUrl(options, record.remoteId),
      null,
      lease.signal,
      true
    )
    if (result === "missing") {
      await put(ctx, options, record, owner)
      const replay = await mutate(
        options,
        "heartbeat",
        heartbeatUrl(options, record.remoteId),
        null,
        lease.signal,
        true
      )
      if (replay === "missing") throw new Error("Consul replayed TTL check is missing")
    }
  } catch (value) {
    const primary = boundaryError(value, "Consul heartbeat rejected with a non-Error value")
    if (retryable(primary) && (await passing(options, record, owner))) return
    throw primary
  } finally {
    lease.release()
  }
}

/** Deregisters one remote ID and resolves ambiguous transport failure by absence. */
async function remove(
  ctx: Context,
  options: OperationOptions,
  remoteId: string,
  owner: AbortSignal | null = null
): Promise<void> {
  const lease = operationLease(ctx, owner, options.timeoutMs)
  try {
    await mutate(options, "deregister", deregisterUrl(options, remoteId), null, lease.signal, true)
  } catch (value) {
    const primary = boundaryError(value, "Consul deregister rejected with a non-Error value")
    if (retryable(primary) && !(await exists(options, remoteId, owner))) return
    throw primary
  } finally {
    lease.release()
  }
}

/** Restores one previously active record after a failed replacement. */
async function restore(active: ActiveRegistration): Promise<void> {
  await put(background(), active.options, active.wire, active.owner.signal)
  await pass(background(), active.options, active.wire, active.owner.signal)
}

/**
 * Creates a registration manager with one private owner per logical instance.
 * `locks` serializes that manager's identities. One set belongs to one registry.
 */
export function newRegistrationManager(
  locks: IdentityLocks = newIdentityLocks()
): RegistrationManager {
  const identities = new Map<string, IdentityState>()

  /** Returns the stable local state for one deterministic identity. */
  function identityState(identity: string): IdentityState {
    const found = identities.get(identity)
    if (found !== undefined) return found
    const created: IdentityState = { active: null, refs: 0 }
    identities.set(identity, created)
    return created
  }

  /** Starts the core renewal loop for one published generation. */
  function startRegistrationHeartbeat(
    ctx: Context,
    state: IdentityState,
    registration: ActiveRegistration
  ): Heartbeat {
    return startHeartbeat(ctx, {
      instance: registration.wire.instance,
      identity: registration.wire.identity,
      locks,
      intervalMs: Math.floor(registration.ttlMs / 2),
      retryInitialMs: registration.options.retryInitialMs,
      retryMaximumMs: registration.options.retryMaximumMs,
      retryable,
      /** Passes the TTL check. Core reports retryable failures. */
      renew(renewCtx: Context): Promise<void> {
        return pass(renewCtx, registration.options, registration.wire, null)
      },
      /** Ends this generation when the Agent rejects the check permanently. */
      lost(error: Error): void {
        if (state.active === registration) state.active = null
        registration.owner.abort(error)
      },
      onRegistrationError: registration.options.common.onRegistrationError,
      message: "Consul private heartbeat failed"
    })
  }

  const manager: RegistrationManager = Object.freeze({
    /** Reports retained identity serializers without joining the package API. */
    identityCount(): number {
      return identities.size
    },
    /** Registers or replaces one instance without exposing private ownership handles. */
    async register(ctx: Context, value: ServiceInstance, options: OperationOptions): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const instance = snapshotServiceInstance(value)
      const wire = await encodeRegistration(
        instance,
        options.ttlMs,
        options.deregisterCriticalServiceAfterMs
      )
      const state = identityState(wire.identity)
      const release = await acquire(locks, identities, wire.identity, state)
      try {
        const previous = state.active
        let published = false
        try {
          await put(ctx, options, wire)
          published = true
          await pass(ctx, options, wire)
          const finalFailure = contextFailure(ctx)
          if (finalFailure !== null) throw finalFailure
        } catch (value) {
          const primary =
            contextFailure(ctx) ??
            boundaryError(value, "Consul registration rejected with a non-Error value")
          if (!published) throw primary
          const rollback: Error[] = []
          try {
            if (previous !== null) {
              await restore(previous)
            } else {
              await remove(background(), options, wire.remoteId)
            }
          } catch (rollbackValue) {
            rollback.push(
              boundaryError(
                rollbackValue,
                "Consul registration rollback rejected with a non-Error value"
              )
            )
          }
          throw rollbackFailure(primary, rollback)
        }
        if (previous?.heartbeat !== null && previous?.heartbeat !== undefined) {
          void previous.heartbeat.stop(background())
        }
        previous?.owner.abort(new Error("Consul registration was replaced"))
        const owner = new AbortController()
        const registration: ActiveRegistration = {
          wire,
          options,
          ttlMs: options.ttlMs,
          owner,
          heartbeat: null
        }
        state.active = registration
        registration.heartbeat = startRegistrationHeartbeat(ctx, state, registration)
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
      const release = await acquire(locks, identities, identity, state)
      try {
        const active = state.active
        const effective = active?.options ?? options
        await remove(ctx, effective, identity)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        if (active?.heartbeat !== null && active?.heartbeat !== undefined) {
          void active.heartbeat.stop(background())
        }
        active?.owner.abort(new Error("Consul registration was deregistered"))
        state.active = null
      } finally {
        release()
      }
    }
  })
  return manager
}
