import type { Context } from "@likego/context"

export type ShipmentStatus = "created" | "pickedUp" | "inTransit" | "outForDelivery" | "delivered"

export interface TrackShipmentCommand {
  readonly eventId: string
  readonly shipmentId: string
  readonly status: ShipmentStatus
  readonly occurredAt: number
}

export interface ShipmentSnapshot {
  readonly shipmentId: string
  readonly status: ShipmentStatus
  readonly lastEventId: string
  readonly occurredAt: number
}

export type TrackingDisposition = "applied" | "duplicate" | "stale"

export interface TrackingOutcome {
  readonly disposition: TrackingDisposition
  readonly shipment: ShipmentSnapshot
}

export interface ShipmentTrackingRepository {
  apply(ctx: Context, command: TrackShipmentCommand): TrackingOutcome
  current(ctx: Context, shipmentId: string): ShipmentSnapshot | undefined
}

export type TrackShipment = (ctx: Context, command: TrackShipmentCommand) => TrackingOutcome

interface SavedEvent {
  readonly fingerprint: string
  readonly outcome: TrackingOutcome
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

function shipmentStatusRank(status: ShipmentStatus): number {
  if (status === "created") return 0
  if (status === "pickedUp") return 1
  if (status === "inTransit") return 2
  if (status === "outForDelivery") return 3
  return 4
}

/** Validates one carrier tracking event. */
export function validateTrackingEvent(command: TrackShipmentCommand): void {
  if (!validId(command.eventId)) throw new TypeError("invalid eventId")
  if (!validId(command.shipmentId)) throw new TypeError("invalid shipmentId")
  if (!Number.isSafeInteger(command.occurredAt) || command.occurredAt < 0) {
    throw new RangeError("occurredAt must be a non-negative safe integer")
  }
}

function trackingEventFingerprint(command: TrackShipmentCommand): string {
  return [command.shipmentId, command.status, String(command.occurredAt)].join("\u0000")
}

function outcome(
  disposition: TrackingOutcome["disposition"],
  shipment: ShipmentSnapshot
): TrackingOutcome {
  return Object.freeze({ disposition, shipment })
}

/** Creates an in-memory event projector with monotonic state and event deduplication. */
export function newMemoryShipmentTrackingRepository(): ShipmentTrackingRepository {
  const shipments = new Map<string, ShipmentSnapshot>()
  const events = new Map<string, SavedEvent>()

  return Object.freeze({
    apply(ctx: Context, command: TrackShipmentCommand): TrackingOutcome {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = trackingEventFingerprint(command)
      const saved = events.get(command.eventId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("event id conflict")
        return outcome("duplicate", saved.outcome.shipment)
      }

      const current = shipments.get(command.shipmentId)
      if (current === undefined && command.status !== "created") {
        throw new Error("shipment must start at created")
      }
      if (
        current !== undefined &&
        (shipmentStatusRank(command.status) <= shipmentStatusRank(current.status) ||
          command.occurredAt <= current.occurredAt)
      ) {
        const stale = outcome("stale", current)
        events.set(command.eventId, Object.freeze({ fingerprint, outcome: stale }))
        return stale
      }

      const shipment = Object.freeze({
        shipmentId: command.shipmentId,
        status: command.status,
        lastEventId: command.eventId,
        occurredAt: command.occurredAt
      })
      const applied = outcome("applied", shipment)
      shipments.set(command.shipmentId, shipment)
      events.set(command.eventId, Object.freeze({ fingerprint, outcome: applied }))
      return applied
    },
    current(ctx: Context, shipmentId: string): ShipmentSnapshot | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return shipments.get(shipmentId)
    }
  })
}

/** Creates the shipment tracking ingestion use case. */
export function newTrackShipment(repository: ShipmentTrackingRepository): TrackShipment {
  return function trackShipment(ctx: Context, command: TrackShipmentCommand): TrackingOutcome {
    validateTrackingEvent(command)
    return repository.apply(ctx, command)
  }
}
