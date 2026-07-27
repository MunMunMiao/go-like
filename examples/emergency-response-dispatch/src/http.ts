import type { Context } from "@likego/context"
import type { ServiceInstance } from "@likego/registry"
import { contextHandler, type Handler } from "@likego/web"

import {
  isEmergencyPriority,
  isEmergencyService,
  newDispatchEmergency,
  type DispatchEmergency,
  type DispatchEmergencyCommand
} from "./service"
import { newMemoryEmergencyDispatchRepository, newRegistryResponderDirectory } from "./dispatch"

/** Decodes and narrows one public emergency dispatch command. */
function commandFrom(value: unknown): DispatchEmergencyCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid JSON body")
  }
  const incidentId: unknown = Reflect.get(value, "incidentId")
  const service: unknown = Reflect.get(value, "service")
  const zone: unknown = Reflect.get(value, "zone")
  const priority: unknown = Reflect.get(value, "priority")
  const reportedAt: unknown = Reflect.get(value, "reportedAt")
  const dispatchBy: unknown = Reflect.get(value, "dispatchBy")
  if (
    typeof incidentId !== "string" ||
    typeof service !== "string" ||
    !isEmergencyService(service) ||
    typeof zone !== "string" ||
    typeof priority !== "string" ||
    !isEmergencyPriority(priority) ||
    typeof reportedAt !== "number" ||
    typeof dispatchBy !== "number"
  ) {
    throw new TypeError("invalid emergency dispatch command")
  }
  return Object.freeze({
    incidentId,
    service,
    zone,
    priority,
    reportedAt,
    dispatchBy
  })
}

/** Creates the standard Fetch boundary for emergency dispatch admission. */
export function newEmergencyDispatchHandler(dispatchEmergency: DispatchEmergency): Handler {
  return contextHandler(async function emergencyDispatchHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/emergency-dispatches") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(dispatchEmergency(ctx, commandFrom(await request.json())), {
        status: 201
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "emergency dispatch failed"
      const status =
        error instanceof TypeError || error instanceof RangeError
          ? 400
          : message === "incident dispatch conflict"
            ? 409
            : 503
      return Response.json({ code: "emergency_dispatch_rejected", message }, { status })
    }
  })
}

export interface EmergencyResponseService {
  readonly handler: Handler
  readonly dispatch: DispatchEmergency
}

/** Composes deadline admission with registry-backed responder selection. */
export function newEmergencyResponseService(
  responders: readonly ServiceInstance[],
  now: () => number = Date.now
): EmergencyResponseService {
  const dispatch = newDispatchEmergency(
    newMemoryEmergencyDispatchRepository(),
    newRegistryResponderDirectory(responders),
    now
  )
  return Object.freeze({
    handler: newEmergencyDispatchHandler(dispatch),
    dispatch
  })
}
