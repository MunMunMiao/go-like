import { background, withCancel } from "@go-like/context"
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

  test("validates tracking boundaries and every HTTP rejection mapping", async () => {
    const repository = newMemoryShipmentTrackingRepository()
    const track = newTrackShipment(repository)
    for (const eventId of ["", " "]) {
      expect(() =>
        track(background(), {
          eventId,
          shipmentId: "shipment",
          status: "created",
          occurredAt: 1
        })
      ).toThrow("invalid eventId")
    }
    expect(() =>
      track(background(), {
        eventId: "event",
        shipmentId: "",
        status: "created",
        occurredAt: 1
      })
    ).toThrow("invalid shipmentId")
    for (const occurredAt of [-1, 1.5]) {
      expect(() =>
        track(background(), {
          eventId: "event",
          shipmentId: "shipment",
          status: "created",
          occurredAt
        })
      ).toThrow("occurredAt must be a non-negative safe integer")
    }
    expect(() =>
      track(background(), {
        eventId: "event-not-created",
        shipmentId: "new-shipment",
        status: "pickedUp",
        occurredAt: 1
      })
    ).toThrow("shipment must start at created")

    const handler = newShipmentTrackingHandler(async () => {
      throw "non-error failure"
    })
    expect(
      (await handler(new Request("https://example.test/v1/other", { method: "GET" }))).status
    ).toBe(404)
    const invalidShape = await handler(
      new Request("https://example.test/v1/tracking-events", {
        method: "POST",
        body: JSON.stringify({ eventId: "event", shipmentId: "shipment", status: "created" })
      })
    )
    expect(invalidShape.status).toBe(400)
    const invalidStatus = await handler(
      new Request("https://example.test/v1/tracking-events", {
        method: "POST",
        body: JSON.stringify({
          eventId: "event",
          shipmentId: "shipment",
          status: "unknown",
          occurredAt: 1
        })
      })
    )
    expect(invalidStatus.status).toBe(400)
    const unknownFailure = await handler(
      new Request("https://example.test/v1/tracking-events", {
        method: "POST",
        body: JSON.stringify({
          eventId: "event",
          shipmentId: "shipment",
          status: "created",
          occurredAt: 1
        })
      })
    )
    expect(unknownFailure.status).toBe(409)
    expect(await unknownFailure.json()).toMatchObject({ message: "tracking event rejected" })
  })

  test("rejects malformed cached snapshots and terminal contexts through real Memory Cache", async () => {
    const service = newCachedShipmentTrackingService()
    const encoder = new TextEncoder()
    const cases = [
      JSON.stringify(null),
      JSON.stringify({ shipmentId: "shipment", status: "created", lastEventId: "event" }),
      JSON.stringify({
        shipmentId: "shipment",
        status: "not-a-status",
        lastEventId: "event",
        occurredAt: 1
      })
    ]
    for (const [index, value] of cases.entries()) {
      await service.cache.put(background(), `shipment:bad-${index}`, encoder.encode(value))
      await expect(service.current(background(), `bad-${index}`)).rejects.toThrow(
        index === 2 ? "cached shipment status is invalid" : "cached shipment snapshot is invalid"
      )
    }
    const [ctx, cancel] = withCancel(background())
    cancel()
    await expect(service.current(ctx, "missing")).rejects.toThrow()
    await expect(
      service.track(ctx, {
        eventId: "canceled",
        shipmentId: "shipment",
        status: "created",
        occurredAt: 1
      })
    ).rejects.toThrow()
  })
})
