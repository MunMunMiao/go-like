const FieldId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface IrrigationCommand {
  readonly fieldId: string
  readonly soilMoisturePercent: number
  readonly observedAt: number
  readonly requestedLiters: number
}

export interface IrrigationPolicy {
  readonly triggerBelowPercent: number
  readonly maxReadingAgeMs: number
  readonly maxLiters: number
}

export interface IrrigationDecision {
  readonly fieldId: string
  readonly status: "notNeeded" | "scheduled"
  readonly liters: number
}

/** Validates one sensor-derived irrigation command at the trust boundary. */
export function validateIrrigationCommand(command: IrrigationCommand): void {
  if (!FieldId.test(command.fieldId)) throw new TypeError("invalid fieldId")
  if (
    !Number.isFinite(command.soilMoisturePercent) ||
    command.soilMoisturePercent < 0 ||
    command.soilMoisturePercent > 100
  ) {
    throw new RangeError("soilMoisturePercent must be between 0 and 100")
  }
  if (!Number.isSafeInteger(command.observedAt) || command.observedAt < 0) {
    throw new RangeError("observedAt must be a non-negative safe integer")
  }
  if (!Number.isSafeInteger(command.requestedLiters) || command.requestedLiters <= 0) {
    throw new RangeError("requestedLiters must be a positive safe integer")
  }
}

/** Validates one complete irrigation policy before Config publication. */
export function validateIrrigationPolicy(policy: IrrigationPolicy): void {
  if (
    !Number.isFinite(policy.triggerBelowPercent) ||
    policy.triggerBelowPercent < 0 ||
    policy.triggerBelowPercent > 100
  ) {
    throw new RangeError("triggerBelowPercent must be between 0 and 100")
  }
  if (!Number.isSafeInteger(policy.maxReadingAgeMs) || policy.maxReadingAgeMs < 0) {
    throw new RangeError("maxReadingAgeMs must be a non-negative safe integer")
  }
  if (!Number.isSafeInteger(policy.maxLiters) || policy.maxLiters <= 0) {
    throw new RangeError("maxLiters must be a positive safe integer")
  }
}

/** Produces a fail-closed irrigation decision from a fresh sensor observation. */
export function decideIrrigation(
  command: IrrigationCommand,
  policy: IrrigationPolicy,
  now: number
): IrrigationDecision {
  validateIrrigationCommand(command)
  validateIrrigationPolicy(policy)
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("now must be valid")
  const ageMs = now - command.observedAt
  if (ageMs < 0) throw new Error("sensor observation is from the future")
  if (ageMs > policy.maxReadingAgeMs) throw new Error("sensor observation is stale")
  if (command.soilMoisturePercent >= policy.triggerBelowPercent) {
    return Object.freeze({ fieldId: command.fieldId, status: "notNeeded", liters: 0 })
  }
  return Object.freeze({
    fieldId: command.fieldId,
    status: "scheduled",
    liters: Math.min(command.requestedLiters, policy.maxLiters)
  })
}
