import type { Context } from "@go-like/context"
import { newProbeRegistry, type ProbeRegistry } from "@go-like/health"

export interface DispatchCommand {
  readonly deliveryId: string
  readonly requiredCapacity: number
}

export interface CourierSeed {
  readonly courierId: string
  readonly capacity: number
  readonly healthy: boolean
}

export interface DispatchAssignment {
  readonly deliveryId: string
  readonly courierId: string
  readonly remainingCapacity: number
}

export interface DispatchRepository {
  assign(ctx: Context, command: DispatchCommand): DispatchAssignment
  availableCapacity(ctx: Context, courierId: string): number
  checkReady(ctx: Context): void
}

export type DispatchDelivery = (ctx: Context, command: DispatchCommand) => DispatchAssignment

export interface DispatchService {
  readonly dispatch: DispatchDelivery
  readonly probes: ProbeRegistry
}

const defaultCouriers: readonly CourierSeed[] = Object.freeze([
  Object.freeze({ courierId: "courier-small", capacity: 2, healthy: true }),
  Object.freeze({ courierId: "courier-large", capacity: 8, healthy: true })
])

interface CourierState {
  readonly courierId: string
  readonly capacity: number
  readonly healthy: boolean
  assignedCapacity: number
}

interface SavedAssignment {
  readonly fingerprint: string
  readonly assignment: DispatchAssignment
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates one delivery request at the application trust boundary. */
export function validateDispatch(command: DispatchCommand): void {
  if (!validId(command.deliveryId)) throw new TypeError("invalid deliveryId")
  if (
    !Number.isSafeInteger(command.requiredCapacity) ||
    command.requiredCapacity <= 0 ||
    command.requiredCapacity > 1_000_000
  ) {
    throw new RangeError("requiredCapacity is outside the supported range")
  }
}

/** Validates one courier record before it enters the dispatch directory. */
export function validateCourier(seed: CourierSeed): void {
  if (!validId(seed.courierId)) throw new TypeError("invalid courierId")
  if (!Number.isSafeInteger(seed.capacity) || seed.capacity <= 0 || seed.capacity > 1_000_000) {
    throw new RangeError("capacity is outside the supported range")
  }
}

/** Produces the stable identity of an idempotent dispatch request. */
function dispatchFingerprint(command: DispatchCommand): string {
  return `${command.deliveryId}\u0000${command.requiredCapacity}`
}

/** Creates an in-memory dispatch directory with atomic capacity accounting. */
export function newMemoryDispatchRepository(seeds: readonly CourierSeed[]): DispatchRepository {
  const couriers = new Map<string, CourierState>()
  const assignments = new Map<string, SavedAssignment>()
  for (const seed of seeds) {
    validateCourier(seed)
    if (couriers.has(seed.courierId)) throw new Error("duplicate courierId")
    couriers.set(seed.courierId, {
      courierId: seed.courierId,
      capacity: seed.capacity,
      healthy: seed.healthy,
      assignedCapacity: 0
    })
  }

  return Object.freeze({
    assign(ctx: Context, command: DispatchCommand): DispatchAssignment {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = dispatchFingerprint(command)
      const saved = assignments.get(command.deliveryId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("dispatch identity conflict")
        return saved.assignment
      }

      let selected: CourierState | undefined
      for (const courier of couriers.values()) {
        const available = courier.capacity - courier.assignedCapacity
        if (!courier.healthy || available < command.requiredCapacity) continue
        if (selected === undefined) {
          selected = courier
          continue
        }
        const selectedAvailable = selected.capacity - selected.assignedCapacity
        if (
          available < selectedAvailable ||
          (available === selectedAvailable &&
            courier.courierId.localeCompare(selected.courierId) < 0)
        ) {
          selected = courier
        }
      }
      if (selected === undefined) throw new Error("no healthy courier capacity")

      selected.assignedCapacity += command.requiredCapacity
      const assignment: DispatchAssignment = Object.freeze({
        deliveryId: command.deliveryId,
        courierId: selected.courierId,
        remainingCapacity: selected.capacity - selected.assignedCapacity
      })
      assignments.set(command.deliveryId, Object.freeze({ fingerprint, assignment }))
      return assignment
    },
    availableCapacity(ctx: Context, courierId: string): number {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const courier = couriers.get(courierId)
      if (courier === undefined) throw new Error("courier not found")
      return courier.capacity - courier.assignedCapacity
    },
    checkReady(ctx: Context): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      for (const courier of couriers.values()) {
        if (courier.healthy && courier.assignedCapacity < courier.capacity) return
      }
      throw new Error("no healthy courier capacity")
    }
  })
}

/** Creates the capacity-aware dispatch use case. */
export function newDispatchDelivery(repository: DispatchRepository): DispatchDelivery {
  return function dispatchDelivery(ctx: Context, command: DispatchCommand): DispatchAssignment {
    validateDispatch(command)
    return repository.assign(ctx, command)
  }
}

/** Creates dispatch handling and its capacity readiness probe. */
export function newDispatchService(
  seeds: readonly CourierSeed[] = defaultCouriers
): DispatchService {
  const repository = newMemoryDispatchRepository(seeds)
  const probes = newProbeRegistry()
  probes.register("ready", "dispatch_capacity", function checkDispatchCapacity(ctx): void {
    repository.checkReady(ctx)
  })
  return Object.freeze({
    dispatch: newDispatchDelivery(repository),
    probes
  })
}
