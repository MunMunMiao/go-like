import { background, withCancel } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newKitchenRoutingHandler } from "../src/http"
import { kitchenRegistryFromEnvironment } from "../src/registry"
import { newMemoryKitchenRoutingStore } from "../src/routing"
import { newRouteKitchenTicket, validateKitchenTicket } from "../src/service"

describe("restaurant kitchen routing", () => {
  test("rejects new work for only the unavailable station", async () => {
    const store = newMemoryKitchenRoutingStore({ fryer: false, grill: true, pastry: true })
    const route = newRouteKitchenTicket(store)
    await expect(
      route(background(), { ticketId: "ticket-fryer", station: "fryer", itemCount: 1 })
    ).rejects.toThrow("fryer station is unavailable")
    await expect(
      route(background(), { ticketId: "ticket-grill", station: "grill", itemCount: 1 })
    ).resolves.toMatchObject({ station: "grill" })
  })

  test("keeps retries stable and rejects a conflicting station", async () => {
    const route = newRouteKitchenTicket(newMemoryKitchenRoutingStore())
    const command = Object.freeze({
      ticketId: "ticket-stable",
      station: "pastry",
      itemCount: 2
    })
    const concurrent = await Promise.all([
      route(background(), command),
      route(background(), command)
    ])
    expect(concurrent[0]).toEqual(concurrent[1])
    await expect(route(background(), command)).resolves.toEqual(concurrent[0])
    await expect(
      route(background(), { ticketId: "ticket-stable", station: "grill", itemCount: 2 })
    ).rejects.toThrow("ticket already assigned to another station")

    const race = newRouteKitchenTicket(newMemoryKitchenRoutingStore())
    const results = await Promise.allSettled([
      race(background(), { ticketId: "ticket-race", station: "grill", itemCount: 1 }),
      race(background(), { ticketId: "ticket-race", station: "pastry", itemCount: 1 })
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: new Error("ticket already assigned to another station")
    })
  })

  test("round-robins new work within the selected station", async () => {
    const route = newRouteKitchenTicket(newMemoryKitchenRoutingStore())
    const first = await route(background(), {
      ticketId: "ticket-a",
      station: "grill",
      itemCount: 1
    })
    const second = await route(background(), {
      ticketId: "ticket-b",
      station: "grill",
      itemCount: 1
    })
    expect(first.kitchenEndpoint).toBe("https://grill-a.example.test/")
    expect(second.kitchenEndpoint).toBe("https://grill-b.example.test/")
  })

  test("rejects unsafe batch sizes through the Fetch boundary", async () => {
    const handler = newKitchenRoutingHandler(newRouteKitchenTicket(newMemoryKitchenRoutingStore()))
    const response = await handler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: JSON.stringify({ ticketId: "ticket-large", station: "grill", itemCount: 51 })
      })
    )
    expect(response.status).toBe(400)
  })

  test("validates command boundaries and exercises every station selector", async () => {
    expect(() =>
      validateKitchenTicket({ ticketId: "bad id", station: "grill", itemCount: 1 })
    ).toThrow("invalid ticketId")
    expect(() =>
      validateKitchenTicket({ ticketId: "ticket", station: "wok" as never, itemCount: 1 })
    ).toThrow("invalid kitchen station")
    expect(() =>
      validateKitchenTicket({ ticketId: "ticket", station: "grill", itemCount: 0 })
    ).toThrow("itemCount must be an integer between 1 and 50")
    const route = newRouteKitchenTicket(newMemoryKitchenRoutingStore())
    await expect(
      route(background(), { ticketId: "fryer-ticket", station: "fryer", itemCount: 1 })
    ).resolves.toMatchObject({
      kitchenEndpoint: "https://fryer-a.example.test/"
    })
    await expect(
      route(background(), { ticketId: "pastry-ticket", station: "pastry", itemCount: 50 })
    ).resolves.toMatchObject({
      kitchenEndpoint: "https://pastry-a.example.test/"
    })
  })

  test("changes readiness, handles HTTP boundaries, and propagates cancellation", async () => {
    const store = newMemoryKitchenRoutingStore()
    store.setReady(background(), "grill", false)
    await expect(
      newRouteKitchenTicket(store)(background(), {
        ticketId: "offline",
        station: "grill",
        itemCount: 1
      })
    ).rejects.toThrow("grill station is unavailable")
    store.setReady(background(), "grill", true)
    const canceled = withCancel(background())
    canceled[1]()
    await expect(
      store.route(canceled[0], { ticketId: "cancelled", station: "grill", itemCount: 1 })
    ).rejects.toThrow()

    const handler = newKitchenRoutingHandler(newRouteKitchenTicket(newMemoryKitchenRoutingStore()))
    const notFound = await handler(new Request("https://example.test/wrong"))
    expect(notFound.status).toBe(404)
    const malformed = await handler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: JSON.stringify([])
      })
    )
    expect(malformed.status).toBe(400)
    const missingField = await handler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: JSON.stringify({ ticketId: "missing", station: "grill" })
      })
    )
    expect(missingField.status).toBe(400)
    const invalidJson = await handler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: "not-json"
      })
    )
    expect(invalidJson.status).toBe(409)
    const unavailableHandler = newKitchenRoutingHandler(
      newRouteKitchenTicket(
        newMemoryKitchenRoutingStore({ fryer: false, grill: true, pastry: true })
      )
    )
    const unavailable = await unavailableHandler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: JSON.stringify({ ticketId: "offline", station: "fryer", itemCount: 1 })
      })
    )
    expect(unavailable.status).toBe(503)
    const conflictHandler = newKitchenRoutingHandler(
      newRouteKitchenTicket(newMemoryKitchenRoutingStore())
    )
    await conflictHandler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: JSON.stringify({ ticketId: "conflict", station: "grill", itemCount: 1 })
      })
    )
    const conflict = await conflictHandler(
      new Request("https://example.test/v1/kitchen/tickets/route", {
        method: "POST",
        body: JSON.stringify({ ticketId: "conflict", station: "pastry", itemCount: 1 })
      })
    )
    expect(conflict.status).toBe(409)
  })

  test("honors explicit mDNS environment requirements without opening the network", () => {
    expect(kitchenRegistryFromEnvironment({})).toBeNull()
    expect(() => kitchenRegistryFromEnvironment({ MDNS_REGISTRY: "0" })).toThrow(
      "MDNS_REGISTRY must be 1"
    )
    expect(() => kitchenRegistryFromEnvironment({ MDNS_REGISTRY: "1" })).toThrow(
      "MDNS_INTERFACE is required"
    )
    expect(
      kitchenRegistryFromEnvironment({
        MDNS_REGISTRY: "1",
        MDNS_INTERFACE: "en0",
        MDNS_DOMAIN: "local."
      })
    ).not.toBeNull()
  })
})
