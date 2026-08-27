import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { MachineSignalKind, MaintenanceSignal, ProcessMaintenanceSignal } from "./service"

function isSignalKind(value: string): value is MachineSignalKind {
  return value === "fault" || value === "recovered"
}

function signalFrom(value: unknown): MaintenanceSignal {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const signalId: unknown = Reflect.get(value, "signalId")
  const machineId: unknown = Reflect.get(value, "machineId")
  const kind: unknown = Reflect.get(value, "kind")
  const rawFaultCode: unknown = Reflect.get(value, "faultCode")
  const occurredAt: unknown = Reflect.get(value, "occurredAt")
  if (
    typeof signalId !== "string" ||
    typeof machineId !== "string" ||
    typeof kind !== "string" ||
    !isSignalKind(kind) ||
    (rawFaultCode !== undefined && rawFaultCode !== null && typeof rawFaultCode !== "string") ||
    typeof occurredAt !== "number"
  ) {
    throw new TypeError("invalid maintenance signal")
  }
  const faultCode = typeof rawFaultCode === "string" ? rawFaultCode : null
  return Object.freeze({ signalId, machineId, kind, faultCode, occurredAt })
}

/** Creates the standard Fetch endpoint for machine maintenance signals. */
export function newMaintenanceHandler(processSignal: ProcessMaintenanceSignal): Handler {
  return contextHandler(async function maintenanceHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/maintenance-signals") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(processSignal(ctx, signalFrom(await request.json())))
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "maintenance_signal_rejected",
          message: error instanceof Error ? error.message : "maintenance signal failed"
        },
        { status }
      )
    }
  })
}
