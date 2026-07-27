import type { Context } from "@likego/context"
import { retry } from "@likego/resilience"

export type PrescriptionStatus = "issued" | "dispensed" | "cancelled"

export interface Prescription {
  readonly prescriptionId: string
  readonly patientId: string
  readonly drugCode: string
  readonly quantity: number
  readonly status: PrescriptionStatus
}

export interface DispensePrescriptionCommand {
  readonly requestId: string
  readonly prescriptionId: string
}

export interface PrescriptionRepository {
  get(ctx: Context, prescriptionId: string): Prescription | undefined
  dispensedBy(ctx: Context, requestId: string): Prescription | undefined
  markDispensed(ctx: Context, prescriptionId: string, requestId: string): Prescription
  cancel(ctx: Context, prescriptionId: string): Prescription
}

export interface PharmacyInventory {
  take(ctx: Context, requestId: string, drugCode: string, quantity: number): void | Promise<void>
  available(ctx: Context, drugCode: string): number
}

export interface MemoryPrescriptionRepositoryOptions {
  readonly prescriptions: readonly Prescription[]
}

export interface MemoryPharmacyInventoryOptions {
  readonly stock: Readonly<Record<string, number>>
}

export type DispensePrescription = (
  ctx: Context,
  command: DispensePrescriptionCommand
) => Promise<Prescription>

export type CancelPrescription = (ctx: Context, prescriptionId: string) => Prescription

export interface TransientInventoryError extends Error {
  readonly name: "TransientInventoryError"
  readonly code: "PHARMACY_INVENTORY_TRANSIENT"
}

const transientName: TransientInventoryError["name"] = "TransientInventoryError"
const transientCode: TransientInventoryError["code"] = "PHARMACY_INVENTORY_TRANSIENT"

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates a dispense request without accepting mutable prescription details. */
export function validateDispensePrescription(command: DispensePrescriptionCommand): void {
  if (!validId(command.requestId)) throw new TypeError("invalid requestId")
  if (!validId(command.prescriptionId)) throw new TypeError("invalid prescriptionId")
}

/** Validates seed prescriptions used by the in-memory adapter. */
export function validatePrescription(prescription: Prescription): void {
  if (!validId(prescription.prescriptionId)) throw new TypeError("invalid prescriptionId")
  if (!validId(prescription.patientId)) throw new TypeError("invalid patientId")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prescription.drugCode)) {
    throw new TypeError("invalid drugCode")
  }
  if (!Number.isSafeInteger(prescription.quantity) || prescription.quantity <= 0) {
    throw new RangeError("quantity must be a positive safe integer")
  }
}

/** Creates an in-memory prescription state repository. */
export function newMemoryPrescriptionRepository(
  options: MemoryPrescriptionRepositoryOptions
): PrescriptionRepository {
  const prescriptions = new Map<string, Prescription>()
  const requests = new Map<string, string>()
  for (const prescription of options.prescriptions) {
    validatePrescription(prescription)
    prescriptions.set(
      prescription.prescriptionId,
      Object.freeze({
        prescriptionId: prescription.prescriptionId,
        patientId: prescription.patientId,
        drugCode: prescription.drugCode,
        quantity: prescription.quantity,
        status: prescription.status
      })
    )
  }

  return Object.freeze({
    get(ctx: Context, prescriptionId: string): Prescription | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return prescriptions.get(prescriptionId)
    },
    dispensedBy(ctx: Context, requestId: string): Prescription | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const prescriptionId = requests.get(requestId)
      return prescriptionId === undefined ? undefined : prescriptions.get(prescriptionId)
    },
    markDispensed(ctx: Context, prescriptionId: string, requestId: string): Prescription {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const previousId = requests.get(requestId)
      if (previousId !== undefined && previousId !== prescriptionId) {
        throw new Error("idempotency conflict")
      }
      const prescription = prescriptions.get(prescriptionId)
      if (prescription === undefined) throw new Error("prescription not found")
      if (prescription.status !== "issued") {
        if (prescription.status === "dispensed" && previousId === prescriptionId) {
          return prescription
        }
        throw new Error("illegal prescription transition")
      }
      const dispensed: Prescription = Object.freeze({
        prescriptionId: prescription.prescriptionId,
        patientId: prescription.patientId,
        drugCode: prescription.drugCode,
        quantity: prescription.quantity,
        status: "dispensed"
      })
      prescriptions.set(prescriptionId, dispensed)
      requests.set(requestId, prescriptionId)
      return dispensed
    },
    cancel(ctx: Context, prescriptionId: string): Prescription {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const prescription = prescriptions.get(prescriptionId)
      if (prescription === undefined) throw new Error("prescription not found")
      if (prescription.status === "cancelled") return prescription
      if (prescription.status !== "issued") throw new Error("illegal prescription transition")
      const cancelled: Prescription = Object.freeze({
        prescriptionId: prescription.prescriptionId,
        patientId: prescription.patientId,
        drugCode: prescription.drugCode,
        quantity: prescription.quantity,
        status: "cancelled"
      })
      prescriptions.set(prescriptionId, cancelled)
      return cancelled
    }
  })
}

/** Creates an in-memory inventory that never mutates stock on an insufficient request. */
export function newMemoryPharmacyInventory(
  options: MemoryPharmacyInventoryOptions
): PharmacyInventory {
  const stock = new Map<string, number>()
  const requests = new Map<string, string>()
  for (const [drugCode, quantity] of Object.entries(options.stock)) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError("invalid stock")
    stock.set(drugCode, quantity)
  }
  return Object.freeze({
    take(ctx: Context, requestId: string, drugCode: string, quantity: number): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = `${drugCode}\u0000${quantity}`
      const previous = requests.get(requestId)
      if (previous !== undefined) {
        if (previous !== fingerprint) throw new Error("inventory idempotency conflict")
        return
      }
      const available = stock.get(drugCode)
      if (available === undefined) throw new Error("unknown drug")
      if (available < quantity) throw new Error("insufficient pharmacy stock")
      stock.set(drugCode, available - quantity)
      requests.set(requestId, fingerprint)
    },
    available(ctx: Context, drugCode: string): number {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const available = stock.get(drugCode)
      if (available === undefined) throw new Error("unknown drug")
      return available
    }
  })
}

/** Creates a dispense use case that marks completion only after inventory succeeds. */
export function newDispensePrescription(
  repository: PrescriptionRepository,
  inventory: PharmacyInventory
): DispensePrescription {
  return async function dispensePrescription(
    ctx: Context,
    command: DispensePrescriptionCommand
  ): Promise<Prescription> {
    validateDispensePrescription(command)
    const previous = repository.dispensedBy(ctx, command.requestId)
    if (previous !== undefined) {
      if (previous.prescriptionId !== command.prescriptionId) {
        throw new Error("idempotency conflict")
      }
      return previous
    }
    const prescription = repository.get(ctx, command.prescriptionId)
    if (prescription === undefined) throw new Error("prescription not found")
    if (prescription.status !== "issued") {
      throw new Error("prescription is not dispensable")
    }
    await inventory.take(ctx, command.requestId, prescription.drugCode, prescription.quantity)
    return repository.markDispensed(ctx, prescription.prescriptionId, command.requestId)
  }
}

/** Creates the legal issued-to-cancelled transition. */
export function newCancelPrescription(repository: PrescriptionRepository): CancelPrescription {
  return function cancelPrescription(ctx: Context, prescriptionId: string): Prescription {
    return repository.cancel(ctx, prescriptionId)
  }
}

/** Creates the stable failure used only for retryable inventory transport faults. */
export function transientInventoryError(message: string): TransientInventoryError {
  return Object.freeze(
    Object.assign(new Error(message), {
      name: transientName,
      code: transientCode
    })
  )
}

/** Reports whether a gateway failure is explicitly marked transient. */
export function isTransientInventoryError(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === transientCode
}

/** Adds bounded retries to an idempotency-keyed inventory gateway. */
export function newRetryingPharmacyInventory(
  gateway: PharmacyInventory,
  maxAttempts: number = 3
): PharmacyInventory {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("maxAttempts must be a positive safe integer")
  }
  return Object.freeze({
    async take(ctx: Context, requestId: string, drugCode: string, quantity: number): Promise<void> {
      await retry(
        ctx,
        (attemptContext) => gateway.take(attemptContext, requestId, drugCode, quantity),
        {
          authorization: "idempotent",
          maxAttempts,
          shouldRetry(_attemptContext, failure): boolean {
            return isTransientInventoryError(failure)
          }
        }
      )
    },
    available(ctx: Context, drugCode: string): number {
      return gateway.available(ctx, drugCode)
    }
  })
}
