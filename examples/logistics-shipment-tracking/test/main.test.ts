import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newCachedShipmentTrackingService } from "../src/cache"
import { newShipmentTrackingHandler } from "../src/http"
import {
  newMemoryShipmentTrackingRepository,
  newTrackShipment,
  type TrackShipmentCommand
} from "../src/service"

describe("logistics shipment tracking", () => {
  test("does not regress state when an older stage arrives late", () => {
    const repository = newMemoryShipmentTrackingRepository()
    const track = newTrackShipment(repository)
    track(background(), {
      eventId: "event-1",
      shipmentId: "shipment-1",
      status: "created",
      occurredAt: 1_000
    })
    track(background(), {
      eventId: "event-2",
      shipmentId: "shipment-1",
      status: "inTransit",
      occurredAt: 3_000
    })
    const stale = track(background(), {
      eventId: "event-3",
      shipmentId: "shipment-1",
      status: "pickedUp",
      occurredAt: 4_000
    })

    expect(stale.disposition).toBe("stale")
    expect(stale.shipment.status).toBe("inTransit")
    expect(repository.current(background(), "shipment-1")?.status).toBe("inTransit")
  })

  test("deduplicates identical events and rejects conflicting event ids", () => {
    const repository = newMemoryShipmentTrackingRepository()
    const track = newTrackShipment(repository)
    const command: TrackShipmentCommand = {
      eventId: "event-1",
      shipmentId: "shipment-1",
      status: "created",
      occurredAt: 1_000
    }

    expect(track(background(), command).disposition).toBe("applied")
    expect(track(background(), command).disposition).toBe("duplicate")
    expect(() =>
      track(background(), {
        eventId: "event-1",
        shipmentId: "shipment-1",
        status: "pickedUp",
        occurredAt: 2_000
      })
    ).toThrow("event id conflict")
  })

  test("accepts monotonic events through a standard Fetch handler", async () => {
    const handler = newShipmentTrackingHandler(
      newTrackShipment(newMemoryShipmentTrackingRepository())
    )
    const created = await handler(
      new Request("https://example.test/v1/tracking-events", {
        method: "POST",
        body: JSON.stringify({
          eventId: "web-1",
          shipmentId: "shipment-1",
          status: "created",
          occurredAt: 1_000
        }),
        headers: { "content-type": "application/json" }
      })
    )
    expect(created.status).toBe(202)

    const delivered = await handler(
      new Request("https://example.test/v1/tracking-events", {
        method: "POST",
        body: JSON.stringify({
          eventId: "web-2",
          shipmentId: "shipment-1",
          status: "delivered",
          occurredAt: 2_000
        }),
        headers: { "content-type": "application/json" }
      })
    )
    expect(delivered.status).toBe(202)
    expect(await delivered.json()).toMatchObject({
      disposition: "applied",
      shipment: { status: "delivered" }
    })
  })

  test("maintains the current projection in an immediately usable Memory Cache", async () => {
    const service = newCachedShipmentTrackingService()
    await service.track(background(), {
      eventId: "cache-1",
      shipmentId: "shipment-cache",
      status: "created",
      occurredAt: 1_000
    })
    await service.track(background(), {
      eventId: "cache-2",
      shipmentId: "shipment-cache",
      status: "inTransit",
      occurredAt: 3_000
    })
    await service.track(background(), {
      eventId: "cache-3",
      shipmentId: "shipment-cache",
      status: "pickedUp",
      occurredAt: 4_000
    })

    expect(await service.current(background(), "shipment-cache")).toEqual({
      shipmentId: "shipment-cache",
      status: "inTransit",
      lastEventId: "cache-2",
      occurredAt: 3_000
    })
    expect(await service.current(background(), "missing")).toBeNull()
  })
})
