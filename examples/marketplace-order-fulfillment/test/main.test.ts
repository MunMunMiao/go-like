import { background } from "@go-like/context"
import { newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"
import { newFulfillmentHandler } from "../src/http"
import {
  newApplyFulfillmentEvent,
  newMarketplaceFulfillmentService,
  newMemoryFulfillmentRepository,
  type FulfillmentCommand
} from "../src/service"

describe("marketplace fulfillment", () => {
  test("advances only through legal stages", () => {
    const apply = newApplyFulfillmentEvent(newMemoryFulfillmentRepository())
    expect(
      apply(background(), { eventId: "e1", orderId: "o1", action: "reserveInventory" }).stage
    ).toBe("inventoryReserved")
    expect(
      apply(background(), { eventId: "e2", orderId: "o1", action: "capturePayment" }).stage
    ).toBe("paymentCaptured")
    expect(apply(background(), { eventId: "e3", orderId: "o1", action: "ship" }).stage).toBe(
      "shipped"
    )
    expect(() => apply(background(), { eventId: "e4", orderId: "o1", action: "cancel" })).toThrow(
      "cannot cancel from shipped"
    )
  })

  test("deduplicates redelivery and rejects conflicting event identities", () => {
    const apply = newApplyFulfillmentEvent(newMemoryFulfillmentRepository())
    const command: FulfillmentCommand = Object.freeze({
      eventId: "same",
      orderId: "o1",
      action: "reserveInventory"
    })
    expect(apply(background(), command)).toEqual(apply(background(), command))
    expect(() =>
      apply(background(), { eventId: "same", orderId: "o2", action: "reserveInventory" })
    ).toThrow("event identity conflict")
  })

  test("serves commands only while Core owns the fulfillment worker", async () => {
    const service = newMarketplaceFulfillmentService()
    const beforeStart = await service.handler(
      new Request("https://example.test/v1/fulfillment-events", {
        method: "POST",
        body: JSON.stringify({
          eventId: "before-start",
          orderId: "order-1",
          action: "reserveInventory"
        })
      })
    )
    expect(beforeStart.status).toBe(409)

    const app = newApp(server(service.worker))
    const running = app.run()
    await Promise.resolve()
    await Promise.resolve()
    try {
      const response = await service.handler(
        new Request("https://example.test/v1/fulfillment-events", {
          method: "POST",
          body: JSON.stringify({
            eventId: "web-1",
            orderId: "order-1",
            action: "reserveInventory"
          })
        })
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        orderId: "order-1",
        stage: "inventoryReserved"
      })
      expect(service.worker.diagnostics()).toEqual({
        status: "running",
        appliedEvents: 1
      })
    } finally {
      await app.stop()
      await running
    }
    expect(service.worker.diagnostics()).toEqual({
      status: "stopped",
      appliedEvents: 1
    })
  })

  test("covers command decoding and worker state boundaries through public APIs", async () => {
    const handler = newFulfillmentHandler(() => ({ orderId: "o1", stage: "placed" as const }))
    expect(
      (await handler(new Request("https://example.test/v1/other", { method: "POST" }))).status
    ).toBe(404)
    const invalid = await handler(
      new Request("https://example.test/v1/fulfillment-events", {
        method: "POST",
        body: JSON.stringify({ eventId: "e1", orderId: "o1", action: "unknown" })
      })
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: "transition_rejected" })

    const repository = newMemoryFulfillmentRepository()
    expect(repository.get(background(), "missing")).toBeNull()
    expect(() =>
      newApplyFulfillmentEvent(repository)(background(), {
        eventId: "bad id",
        orderId: "o1",
        action: "reserveInventory"
      })
    ).toThrow("invalid eventId")
    expect(() =>
      newApplyFulfillmentEvent(repository)(background(), {
        eventId: "e-valid",
        orderId: "bad id",
        action: "reserveInventory"
      })
    ).toThrow("invalid orderId")

    const workerService = newMarketplaceFulfillmentService()
    expect(() => workerService.worker.get(background(), "o1")).toThrow(
      "fulfillment worker is not running"
    )
    const app = newApp(server(workerService.worker))
    const running = app.run()
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(workerService.worker.get(background(), "missing")).toBeNull()
      await expect(workerService.worker.start(background())).rejects.toThrow(
        "fulfillment worker already started"
      )
    } finally {
      await app.stop()
      await running
    }
    await workerService.worker.stop(background())
    expect(workerService.worker.diagnostics()).toEqual({ status: "stopped", appliedEvents: 0 })
  })
})
