import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newReservationHandler } from "../src/http"
import { newRetailInventoryService } from "../src/service"

function newTestService(stock: Readonly<Record<string, number>>) {
  const service = newRetailInventoryService(stock)
  return Object.freeze({
    handler: newReservationHandler(service.reserve, service.available),
    reserve: service.reserve,
    available: service.available
  })
}

describe("retail inventory reservation", () => {
  test("prevents overselling and keeps idempotent retries stable", async () => {
    const service = newTestService({ mug: 5 })
    const expiresAt = Date.now() + 10_000
    const command = { requestId: "request-1", sku: "mug", quantity: 4, expiresAt }
    await expect(service.reserve(background(), command)).resolves.toEqual(command)
    await expect(service.reserve(background(), command)).resolves.toEqual(command)
    await expect(service.available(background(), "mug")).resolves.toEqual({
      sku: "mug",
      available: 1
    })
    await expect(
      service.reserve(background(), {
        requestId: "request-2",
        sku: "mug",
        quantity: 2,
        expiresAt
      })
    ).rejects.toThrow("insufficient stock")
  })

  test("rejects conflicting reuse of one request id", async () => {
    const service = newTestService({ mug: 5 })
    await service.reserve(background(), {
      requestId: "same",
      sku: "mug",
      quantity: 1,
      expiresAt: Date.now() + 10_000
    })
    await expect(
      service.reserve(background(), {
        requestId: "same",
        sku: "mug",
        quantity: 2,
        expiresAt: Date.now() + 10_000
      })
    ).rejects.toThrow("idempotency conflict")
  })

  test("serves and refreshes inventory through the go-like cache", async () => {
    const service = newTestService({ mug: 5 })
    const initial = await service.handler(new Request("https://example.test/v1/inventory/mug"))
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({ sku: "mug", available: 5 })

    const reserved = await service.handler(
      new Request("https://example.test/v1/reservations", {
        method: "POST",
        body: JSON.stringify({
          requestId: "web-1",
          sku: "mug",
          quantity: 2,
          expiresAt: Date.now() + 10_000
        }),
        headers: { "content-type": "application/json" }
      })
    )
    expect(reserved.status).toBe(201)

    const remaining = await service.handler(new Request("https://example.test/v1/inventory/mug"))
    expect(await remaining.json()).toEqual({ sku: "mug", available: 3 })
  })
})
