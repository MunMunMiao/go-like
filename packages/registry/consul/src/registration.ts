import { background, type Context } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { notifyRegistrationError, snapshotServiceInstance } from "@go-like/registry/provider"

import {
  decodeAgentReadback,
  encodeRegistration,
  registrationIdentity,
  type EncodedRegistration
} from "./codec"
import { boundaryError, rollbackFailure } from "./errors"
import { consulUrl, mutate, queryText, retryable } from "./http"
import type { OperationOptions } from "./options"
import { completion, contextFailure, ignoreFailure, operationLease, waitForSignal } from "./runtime"

interface IdentityState {
  tail: Promise<void>
  active: ActiveRegistration | null
  refs: number
}

interface ActiveRegistration {
  readonly wire: EncodedRegistration
  readonly options: OperationOptions
  readonly ttlMs: number
  readonly owner: AbortController
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

/** Reports one private heartbeat failure without changing the public operation result. */
function report(options: OperationOptions, level: "warn" | "error", error: Error): void {
  try {
    options.common.logger?.log(level, "Consul registration heartbeat failed", {
      code: "code" in error ? error.code : undefined,
      name: error.name
    })
  } catch {
    // Registry loggers are borrowed diagnostics and cannot control provider state.
  }
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

/** Creates a registration manager with one private owner per logical instance. */
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

  /** Runs one retrying private TTL heartbeat for the current generation only. */
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
          await pass(
            background(),
            registration.options,
            registration.wire,
            registration.owner.signal
          )
          delayMs = Math.floor(registration.ttlMs / 2)
        } catch (value) {
          const error = boundaryError(
            value,
            "Consul private heartbeat rejected with a non-Error value"
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
            Math.max(registration.options.retryInitialMs, delayMs / 2)
          )
        }
      } finally {
        release()
      }
    }
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
      const release = await acquire(identities, wire.identity, state)
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
        previous?.owner.abort(new Error("Consul registration was replaced"))
        const owner = new AbortController()
        const registration: ActiveRegistration = {
          wire,
          options,
          ttlMs: options.ttlMs,
          owner
        }
        const heartbeat = heartbeatLoop(state, registration)
        state.active = registration
        void heartbeat.catch(ignoreFailure)
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
        await remove(ctx, effective, identity)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        active?.owner.abort(new Error("Consul registration was deregistered"))
        state.active = null
      } finally {
        release()
      }
    }
  })
  return manager
}
