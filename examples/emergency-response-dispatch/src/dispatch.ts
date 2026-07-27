import type { Context } from "@likego/context"
import { newRoundRobinSelector, type ServiceInstance } from "@likego/registry"

import {
  dispatchFingerprint,
  type DispatchEmergencyCommand,
  type EmergencyDispatch
} from "./service"

export interface SavedEmergencyDispatch {
  readonly fingerprint: string
  readonly dispatch: EmergencyDispatch
}

export interface EmergencyDispatchRepository {
  get(ctx: Context, incidentId: string): SavedEmergencyDispatch | null
  save(
    ctx: Context,
    command: DispatchEmergencyCommand,
    dispatch: EmergencyDispatch
  ): EmergencyDispatch
}

export interface SelectedResponder {
  readonly responderId: string
  readonly endpoint: string
}

export interface ResponderDirectory {
  select(ctx: Context, command: DispatchEmergencyCommand): SelectedResponder
}

/** Rejects work admitted through a terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates a deterministic in-memory dispatch record repository. */
export function newMemoryEmergencyDispatchRepository(): EmergencyDispatchRepository {
  const savedByIncident = new Map<string, SavedEmergencyDispatch>()
  return Object.freeze({
    get(ctx: Context, incidentId: string): SavedEmergencyDispatch | null {
      checkContext(ctx)
      return savedByIncident.get(incidentId) ?? null
    },
    save(
      ctx: Context,
      command: DispatchEmergencyCommand,
      dispatch: EmergencyDispatch
    ): EmergencyDispatch {
      checkContext(ctx)
      const fingerprint = dispatchFingerprint(command)
      const saved = savedByIncident.get(command.incidentId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("incident dispatch conflict")
        return saved.dispatch
      }
      savedByIncident.set(command.incidentId, Object.freeze({ fingerprint, dispatch }))
      return dispatch
    }
  })
}

/** Creates a responder directory backed by LikeGo's round-robin Registry selector. */
export function newRegistryResponderDirectory(
  instances: readonly ServiceInstance[]
): ResponderDirectory {
  const selector = newRoundRobinSelector()
  return Object.freeze({
    select(ctx: Context, command: DispatchEmergencyCommand): SelectedResponder {
      checkContext(ctx)
      const matching: ServiceInstance[] = []
      for (const instance of instances) {
        if (
          instance.metadata.zone === command.zone &&
          instance.metadata.service === command.service &&
          instance.metadata.readiness === "ready"
        ) {
          matching.push(instance)
        }
      }
      const selected = selector.select(ctx, matching)
      selected[1](ctx, { error: null })
      return Object.freeze({
        responderId: selected[0].instance.id,
        endpoint: selected[0].url
      })
    }
  })
}
