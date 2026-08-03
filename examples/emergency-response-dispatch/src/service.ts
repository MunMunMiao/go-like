import type { Context } from "@likego/context"
import type { EmergencyDispatchRepository, ResponderDirectory } from "./dispatch"

export type EmergencyService = "fire" | "medical" | "police"
export type EmergencyPriority = "critical" | "urgent"

export interface DispatchEmergencyCommand {
  readonly incidentId: string
  readonly service: EmergencyService
  readonly zone: string
  readonly priority: EmergencyPriority
  readonly reportedAt: number
  readonly dispatchBy: number
}

export interface EmergencyDispatch {
  readonly incidentId: string
  readonly priority: EmergencyPriority
  readonly responderId: string
  readonly endpoint: string
  readonly dispatchBy: number
  readonly status: "assigned"
}

const criticalSlaMs = 5 * 60 * 1_000
const urgentSlaMs = 15 * 60 * 1_000
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** Narrows one public string to an emergency service. */
export function isEmergencyService(value: string): value is EmergencyService {
  return value === "fire" || value === "medical" || value === "police"
}

/** Narrows one public string to an emergency priority. */
export function isEmergencyPriority(value: string): value is EmergencyPriority {
  return value === "critical" || value === "urgent"
}

/** Returns the maximum response window admitted by one priority. */
export function prioritySlaMs(priority: EmergencyPriority): number {
  return priority === "critical" ? criticalSlaMs : urgentSlaMs
}

/** Validates one dispatch command and its priority-specific deadline. */
export function validateDispatchCommand(command: DispatchEmergencyCommand, now: number): void {
  if (!identifier.test(command.incidentId)) throw new TypeError("invalid incidentId")
  if (!identifier.test(command.zone)) throw new TypeError("invalid zone")
  if (!isEmergencyService(command.service)) throw new TypeError("invalid service")
  if (!isEmergencyPriority(command.priority)) throw new TypeError("invalid priority")
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("invalid clock")
  if (!Number.isSafeInteger(command.reportedAt) || command.reportedAt > now) {
    throw new RangeError("reportedAt must not be in the future")
  }
  if (!Number.isSafeInteger(command.dispatchBy) || command.dispatchBy <= now) {
    throw new RangeError("dispatch deadline has expired")
  }
  const latest = command.reportedAt + prioritySlaMs(command.priority)
  if (!Number.isSafeInteger(latest) || command.dispatchBy > latest) {
    throw new RangeError(`${command.priority} dispatch exceeds its response SLA`)
  }
}

/** Produces an unambiguous fingerprint for one dispatch request. */
export function dispatchFingerprint(command: DispatchEmergencyCommand): string {
  return `${command.service.length}:${command.service}${command.zone.length}:${command.zone}${command.priority.length}:${command.priority}${command.reportedAt}:${command.dispatchBy}`
}

export type DispatchEmergency = (
  ctx: Context,
  command: DispatchEmergencyCommand
) => EmergencyDispatch

/** Creates the idempotent emergency dispatch use case with an injectable clock. */
export function newDispatchEmergency(
  repository: EmergencyDispatchRepository,
  responders: ResponderDirectory,
  now: () => number = Date.now
): DispatchEmergency {
  return function dispatchEmergency(
    ctx: Context,
    command: DispatchEmergencyCommand
  ): EmergencyDispatch {
    validateDispatchCommand(command, now())
    const fingerprint = dispatchFingerprint(command)
    const saved = repository.get(ctx, command.incidentId)
    if (saved !== null) {
      if (saved.fingerprint !== fingerprint) {
        throw new Error("incident dispatch conflict")
      }
      return saved.dispatch
    }
    const responder = responders.select(ctx, command)
    return repository.save(
      ctx,
      command,
      Object.freeze({
        incidentId: command.incidentId,
        priority: command.priority,
        responderId: responder.responderId,
        endpoint: responder.endpoint,
        dispatchBy: command.dispatchBy,
        status: "assigned"
      })
    )
  }
}
