import { background, withCancel } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newMemoryCache } from "@go-like/cache-memory"
import { newReservationHandler } from "../src/http"
import {
  newGetAvailableStock,
  newMemoryInventoryRepository,
  newReserveStock,
  newRetailInventoryService,
  validateReservation,
  validateSku
} from "../src/service"

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

  test("validates inventory inputs and repository boundaries", async () => {
    expect(() => validateSku("bad sku")).toThrow("invalid sku")
    expect(() =>
      validateReservation({ requestId: "bad id", sku: "mug", quantity: 1, expiresAt: 2 }, 1)
    ).toThrow("invalid requestId")
    expect(() =>
      validateReservation({ requestId: "ok", sku: "bad sku", quantity: 1, expiresAt: 2 }, 1)
    ).toThrow("invalid sku")
    expect(() =>
      validateReservation({ requestId: "ok", sku: "mug", quantity: 0, expiresAt: 2 }, 1)
    ).toThrow("quantity")
    expect(() =>
      validateReservation({ requestId: "ok", sku: "mug", quantity: 1, expiresAt: 1 }, 1)
    ).toThrow("expiresAt")
    expect(() => newMemoryInventoryRepository({ "bad sku": 1 })).toThrow("invalid sku")
    expect(() => newMemoryInventoryRepository({ mug: -1 })).toThrow("invalid stock")
    const repository = newMemoryInventoryRepository({ mug: 1 })
    const canceled = withCancel(background())
    canceled[1]()
    expect(() =>
      repository.reserve(canceled[0], {
        requestId: "cancelled",
        sku: "mug",
        quantity: 1,
        expiresAt: 10
      })
    ).toThrow()
    expect(() => repository.available(background(), "missing")).toThrow("unknown sku")
    expect(() =>
      repository.reserve(background(), {
        requestId: "unknown",
        sku: "missing",
        quantity: 1,
        expiresAt: 10
      })
    ).toThrow("unknown sku")
  })

  test("handles malformed cache bytes and HTTP error mappings", async () => {
    const repository = newMemoryInventoryRepository({ mug: 4 })
    const cache = newMemoryCache()
    const available = newGetAvailableStock(repository, cache, 10)
    await cache.put(background(), "inventory-available:v1:mug", new Uint8Array([0xff]))
    await expect(available(background(), "mug")).resolves.toEqual({ sku: "mug", available: 4 })
    await cache.put(background(), "inventory-available:v1:mug", new TextEncoder().encode("-1"))
    await expect(available(background(), "mug")).resolves.toEqual({ sku: "mug", available: 4 })
    expect(() => newGetAvailableStock(repository, cache, 0)).toThrow("cache ttl")

    const service = newTestService({ mug: 2 })
    const invalidReservation = await service.handler(
      new Request("https://example.test/v1/reservations", {
        method: "POST",
        body: JSON.stringify({
          requestId: "bad id",
          sku: "mug",
          quantity: 1,
          expiresAt: Date.now() + 1_000
        })
      })
    )
    expect(invalidReservation.status).toBe(400)
    const unknownInventory = await service.handler(
      new Request("https://example.test/v1/inventory/missing")
    )
    expect(unknownInventory.status).toBe(404)
    const malformedInventory = await service.handler(
      new Request("https://example.test/v1/inventory/%E0%A4%A")
    )
    expect(malformedInventory.status).toBe(400)
    const notFound = await service.handler(new Request("https://example.test/nope"))
    expect(notFound.status).toBe(404)
    const badJson = await service.handler(
      new Request("https://example.test/v1/reservations", {
        method: "POST",
        body: "not-json"
      })
    )
    expect(badJson.status).toBe(409)
    const wrongShape = await service.handler(
      new Request("https://example.test/v1/reservations", {
        method: "POST",
        body: JSON.stringify([])
      })
    )
    expect(wrongShape.status).toBe(400)
  })

  test("uses a fixed clock when reserving stock", async () => {
    const repository = newMemoryInventoryRepository({ mug: 2 })
    const cache = newMemoryCache()
    const reserve = newReserveStock(repository, cache, () => 100)
    await expect(
      reserve(background(), { requestId: "fixed", sku: "mug", quantity: 1, expiresAt: 101 })
    ).resolves.toMatchObject({
      requestId: "fixed"
    })
    await expect(
      reserve(background(), { requestId: "expired", sku: "mug", quantity: 1, expiresAt: 100 })
    ).rejects.toThrow("expiresAt")
  })
})
