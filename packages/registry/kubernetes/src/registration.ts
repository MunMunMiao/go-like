import type { Context } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { newRegistryProtocolError } from "@go-like/registry/provider"

import { encodeCandidate, encodeSlice, type SliceCandidate } from "./codec"
import { boundaryError } from "./errors"
import { conflict, notFound, retryable } from "./http"
import type { OperationOptions } from "./options"
import { createSlice, deleteSlice, getSlice, updateSlice } from "./protocol"
import { contextFailure, operationLease, signalFailure, waitForSignal } from "./runtime"
import type { KubernetesPodOwner } from "./types"

/** Performs stateless idempotent Kubernetes registration mutations. */
export interface RegistrationManager {
  /** Registers or replaces one immutable ServiceInstance. */
  register(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
  /** Deregisters one exact ServiceInstance when it remains current. */
  deregister(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
}

/** Returns whether one managed readback exactly matches a mutation candidate. */
function matches(candidate: SliceCandidate, value: { readonly content: string }): boolean {
  return value.content === candidate.content
}

/** Confirms both service content and the configured lifecycle owner. */
function publicationMatches(
  candidate: SliceCandidate,
  value: { readonly content: string; readonly owner: KubernetesPodOwner | null },
  owner: KubernetesPodOwner | null
): boolean {
  return (
    matches(candidate, value) &&
    value.owner?.name === owner?.name &&
    value.owner?.uid === owner?.uid
  )
}

/** Converts one retryable mutation failure into the next bounded wait or final failure. */
async function retry(
  ctx: Context,
  signal: AbortSignal,
  options: OperationOptions,
  delayMs: number,
  value: unknown
): Promise<number> {
  const failure =
    contextFailure(ctx) ??
    (signal.aborted
      ? signalFailure(signal, "Kubernetes Registry operation was aborted")
      : boundaryError(value, "Kubernetes Registry mutation rejected with a non-Error value"))
  if (signal.aborted || (!conflict(failure) && !notFound(failure) && !retryable(failure))) {
    throw failure
  }
  await waitForSignal(signal, delayMs)
  return Math.min(options.retryMaximumMs, delayMs * 2)
}

/** Creates one stateless registration manager over deterministic EndpointSlice names. */
export function newRegistrationManager(): RegistrationManager {
  return Object.freeze({
    /** Creates or CAS-replaces one deterministic managed EndpointSlice. */
    async register(ctx: Context, value: ServiceInstance, options: OperationOptions): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const candidate = await encodeCandidate(value)
      const lease = operationLease(ctx, null, options.timeoutMs)
      let retryMs = options.retryInitialMs
      try {
        while (true) {
          try {
            const existing = await getSlice(options, candidate.name, lease.signal)
            let published
            if (existing === "foreign") {
              throw newRegistryProtocolError(
                "Kubernetes foreign EndpointSlice occupies the canonical go-like name"
              )
            } else if (existing === null) {
              published = await createSlice(
                options,
                encodeSlice(candidate, options.namespace, null, options.owner),
                lease.signal
              )
            } else {
              published = await updateSlice(
                options,
                candidate.name,
                encodeSlice(candidate, options.namespace, existing.resourceVersion, options.owner),
                lease.signal
              )
            }
            if (!publicationMatches(candidate, published, options.owner)) {
              throw newRegistryProtocolError(
                "Kubernetes registration response did not confirm the requested instance"
              )
            }
            const finalFailure = contextFailure(ctx)
            if (finalFailure !== null) throw finalFailure
            return
          } catch (value) {
            retryMs = await retry(ctx, lease.signal, options, retryMs, value)
          }
        }
      } finally {
        lease.release()
      }
    },
    /** Deletes one exact current instance and leaves a newer replacement intact. */
    async deregister(
      ctx: Context,
      value: ServiceInstance,
      options: OperationOptions
    ): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const candidate = await encodeCandidate(value)
      const lease = operationLease(ctx, null, options.timeoutMs)
      let retryMs = options.retryInitialMs
      try {
        while (true) {
          try {
            const existing = await getSlice(options, candidate.name, lease.signal)
            if (
              existing === null ||
              existing === "foreign" ||
              !publicationMatches(candidate, existing, options.owner)
            ) {
              return
            }
            await deleteSlice(options, candidate.name, existing.resourceVersion, lease.signal)
            const finalFailure = contextFailure(ctx)
            if (finalFailure !== null) throw finalFailure
            return
          } catch (value) {
            if (notFound(value)) return
            retryMs = await retry(ctx, lease.signal, options, retryMs, value)
          }
        }
      } finally {
        lease.release()
      }
    }
  })
}
