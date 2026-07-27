import { newMemoryCache, type MemoryCache } from "@likego/cache-memory"
import type { Context } from "@likego/context"
import {
  newMemoryShipmentTrackingRepository,
  newTrackShipment,
  type ShipmentSnapshot,
  type ShipmentStatus,
  type TrackShipmentCommand,
  type TrackingOutcome,
  type TrackShipment
} from "./service"

const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })

export interface CachedShipmentTrackingService {
  readonly cache: MemoryCache
  track(ctx: Context, command: TrackShipmentCommand): Promise<TrackingOutcome>
  current(ctx: Context, shipmentId: string): Promise<ShipmentSnapshot | null>
}

/** Returns one admitted shipment status from a cached payload. */
function cachedStatus(value: unknown): ShipmentStatus {
  if (
    value === "created" ||
    value === "pickedUp" ||
    value === "inTransit" ||
    value === "outForDelivery" ||
    value === "delivered"
  ) {
    return value
  }
  throw new TypeError("cached shipment status is invalid")
}

/** Decodes and validates one current-snapshot cache value. */
function decodeSnapshot(bytes: Uint8Array): ShipmentSnapshot {
  const value: unknown = JSON.parse(Decoder.decode(bytes))
  if (value === null || typeof value !== "object") {
    throw new TypeError("cached shipment snapshot is invalid")
  }
  const shipmentId: unknown = Reflect.get(value, "shipmentId")
  const status: unknown = Reflect.get(value, "status")
  const lastEventId: unknown = Reflect.get(value, "lastEventId")
  const occurredAt: unknown = Reflect.get(value, "occurredAt")
  if (
    typeof shipmentId !== "string" ||
    typeof lastEventId !== "string" ||
    typeof occurredAt !== "number" ||
    !Number.isSafeInteger(occurredAt) ||
    occurredAt < 0
  ) {
    throw new TypeError("cached shipment snapshot is invalid")
  }
  return Object.freeze({
    shipmentId,
    status: cachedStatus(status),
    lastEventId,
    occurredAt
  })
}

/** Composes a shipment tracker whose current projection is maintained by Memory Cache. */
export function newCachedShipmentTrackingService(): CachedShipmentTrackingService {
  const cache = newMemoryCache()
  const track: TrackShipment = newTrackShipment(newMemoryShipmentTrackingRepository())

  return Object.freeze({
    cache,
    async track(callContext: Context, command: TrackShipmentCommand): Promise<TrackingOutcome> {
      const result = track(callContext, command)
      await cache.put(
        callContext,
        `shipment:${result.shipment.shipmentId}`,
        Encoder.encode(JSON.stringify(result.shipment))
      )
      return result
    },
    async current(callContext: Context, shipmentId: string): Promise<ShipmentSnapshot | null> {
      const bytes = await cache.get(callContext, `shipment:${shipmentId}`)
      return bytes === null ? null : decodeSnapshot(bytes)
    }
  })
}
