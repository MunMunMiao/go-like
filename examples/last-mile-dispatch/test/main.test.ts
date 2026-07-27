import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"
import { newDispatchHandler } from "../src/http"
import {
  newDispatchDelivery,
  newDispatchService,
  newMemoryDispatchRepository
} from "../src/service"

describe("last mile dispatch", () => {
  test("skips unhealthy couriers even when they have the best capacity fit", () => {
    const dispatch = newDispatchDelivery(
      newMemoryDispatchRepository([
        { courierId: "offline", capacity: 2, healthy: false },
        { courierId: "online", capacity: 5, healthy: true }
      ])
    )
    expect(dispatch(background(), { deliveryId: "delivery-1", requiredCapacity: 2 })).toMatchObject(
      { courierId: "online", remainingCapacity: 3 }
    )
  })

  test("never exceeds capacity and keeps retries idempotent", () => {
    const repository = newMemoryDispatchRepository([
      { courierId: "courier-1", capacity: 3, healthy: true }
    ])
    const dispatch = newDispatchDelivery(repository)
    const command = Object.freeze({ deliveryId: "same", requiredCapacity: 2 })
    expect(dispatch(background(), command)).toEqual(dispatch(background(), command))
    expect(repository.availableCapacity(background(), "courier-1")).toBe(1)
    expect(() => dispatch(background(), { deliveryId: "delivery-2", requiredCapacity: 2 })).toThrow(
      "no healthy courier capacity"
    )
  })

  test("rejects conflicting reuse of a delivery identity", () => {
    const dispatch = newDispatchDelivery(
      newMemoryDispatchRepository([{ courierId: "courier-1", capacity: 5, healthy: true }])
    )
    dispatch(background(), { deliveryId: "same", requiredCapacity: 1 })
    expect(() => dispatch(background(), { deliveryId: "same", requiredCapacity: 2 })).toThrow(
      "dispatch identity conflict"
    )
  })

  test("serves dispatch through a standard Fetch handler", async () => {
    const service = newDispatchService([{ courierId: "web-courier", capacity: 4, healthy: true }])
    const response = await newDispatchHandler(service.dispatch)(
      new Request("https://example.test/v1/dispatches", {
        method: "POST",
        body: JSON.stringify({ deliveryId: "web-1", requiredCapacity: 3 })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      courierId: "web-courier",
      remainingCapacity: 1
    })
  })

  test("reports exhausted healthy capacity through LikeGo readiness", async () => {
    const service = newDispatchService([{ courierId: "probe-courier", capacity: 1, healthy: true }])
    expect((await service.probes.check(background(), "ready")).ok).toBe(true)
    await newDispatchHandler(service.dispatch)(
      new Request("https://example.test/v1/dispatches", {
        method: "POST",
        body: JSON.stringify({ deliveryId: "probe-delivery", requiredCapacity: 1 })
      })
    )
    expect((await service.probes.check(background(), "ready")).ok).toBe(false)
  })
})
