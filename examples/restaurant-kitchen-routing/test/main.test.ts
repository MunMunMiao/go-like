import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"

import { newKitchenRoutingHandler } from "../src/http"
import { newMemoryKitchenRoutingStore } from "../src/routing"
import { newRouteKitchenTicket } from "../src/service"

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
})
