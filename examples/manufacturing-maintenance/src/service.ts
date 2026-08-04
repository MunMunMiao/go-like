import type { Context } from "@go-like/context"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

import { newMaintenanceHandler } from "./http"

/** Enumerates the two state transitions emitted by a machine. */
export type MachineSignalKind = "fault" | "recovered"

export interface MaintenanceSignal {
  readonly signalId: string
  readonly machineId: string
  readonly kind: MachineSignalKind
  readonly faultCode: string | null
  readonly occurredAt: number
}

export interface MaintenanceTransition {
  readonly signalId: string
  readonly machineId: string
  readonly activeWorkOrderId: string | null
  readonly created: boolean
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates one machine fault or recovery signal. */
export function validateMaintenanceSignal(signal: MaintenanceSignal): void {
  if (!validId(signal.signalId)) throw new TypeError("invalid signalId")
  if (!validId(signal.machineId)) throw new TypeError("invalid machineId")
  if (!Number.isSafeInteger(signal.occurredAt) || signal.occurredAt < 0) {
    throw new RangeError("invalid occurredAt")
  }
  if (signal.kind === "fault") {
    if (signal.faultCode === null || !validId(signal.faultCode)) {
      throw new TypeError("faultCode is required for fault")
    }
    return
  }
  if (signal.faultCode !== null) {
    throw new TypeError("faultCode must be null for recovery")
  }
}

/** Produces the stable identity of one idempotent equipment signal. */
export function maintenanceSignalFingerprint(signal: MaintenanceSignal): string {
  return [signal.machineId, signal.kind, signal.faultCode ?? "", String(signal.occurredAt)].join(
    "\u0000"
  )
}

export interface MaintenanceRepository {
  process(ctx: Context, signal: MaintenanceSignal): MaintenanceTransition
  checkReady(ctx: Context): void
}

interface MachineState {
  readonly lastOccurredAt: number
  readonly activeWorkOrderId: string | null
  readonly windowNumber: number
}

interface SavedSignal {
  readonly fingerprint: string
  readonly transition: MaintenanceTransition
}

/** Creates an in-memory repository with one active fault window per machine. */
export function newMemoryMaintenanceRepository(): MaintenanceRepository {
  const machines = new Map<string, MachineState>()
  const signals = new Map<string, SavedSignal>()

  return Object.freeze({
    process(ctx: Context, signal: MaintenanceSignal): MaintenanceTransition {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = maintenanceSignalFingerprint(signal)
      const saved = signals.get(signal.signalId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("signal identity conflict")
        return saved.transition
      }

      const current = machines.get(signal.machineId)
      if (current !== undefined && signal.occurredAt < current.lastOccurredAt) {
        throw new Error("out-of-order signal")
      }
      const previousWindow = current?.windowNumber ?? 0
      const previousWorkOrder = current?.activeWorkOrderId ?? null
      let activeWorkOrderId = previousWorkOrder
      let windowNumber = previousWindow
      let created = false

      if (signal.kind === "fault" && activeWorkOrderId === null) {
        windowNumber += 1
        activeWorkOrderId = `wo-${signal.machineId}-${windowNumber}`
        created = true
      }
      if (signal.kind === "recovered") activeWorkOrderId = null

      const transition: MaintenanceTransition = Object.freeze({
        signalId: signal.signalId,
        machineId: signal.machineId,
        activeWorkOrderId,
        created
      })
      machines.set(
        signal.machineId,
        Object.freeze({
          lastOccurredAt: signal.occurredAt,
          activeWorkOrderId,
          windowNumber
        })
      )
      signals.set(signal.signalId, Object.freeze({ fingerprint, transition }))
      return transition
    },
    checkReady(ctx: Context): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
    }
  })
}

export type ProcessMaintenanceSignal = (
  ctx: Context,
  signal: MaintenanceSignal
) => MaintenanceTransition

/** Creates the fault-window maintenance operation. */
export function newProcessMaintenanceSignal(
  repository: MaintenanceRepository
): ProcessMaintenanceSignal {
  return function processMaintenanceSignal(
    ctx: Context,
    signal: MaintenanceSignal
  ): MaintenanceTransition {
    validateMaintenanceSignal(signal)
    return repository.process(ctx, signal)
  }
}

/** Composes fault-window handling as an embeddable standard Fetch handler. */
export function newHandler(): Handler {
  return newRuntime().handler
}

/** Composes maintenance handling and repository readiness. */
export function newRuntime() {
  const repository = newMemoryMaintenanceRepository()
  const probes = newProbeRegistry()
  probes.register("ready", "maintenance_repository", function checkRepository(ctx): void {
    repository.checkReady(ctx)
  })
  return Object.freeze({
    handler: newMaintenanceHandler(newProcessMaintenanceSignal(repository)),
    probes
  })
}
