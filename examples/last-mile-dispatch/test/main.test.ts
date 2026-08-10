import { background, withCancel } from "@go-like/context"
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
    const handler = newDispatchHandler(service.dispatch)
    const response = await handler(
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
    expect(
      (await handler(new Request("https://example.test/v1/other", { method: "GET" }))).status
    ).toBe(404)
    expect(
      (
        await handler(
          new Request("https://example.test/v1/dispatches", {
            method: "POST",
            body: JSON.stringify({ deliveryId: "web-invalid", requiredCapacity: "3" })
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handler(
          new Request("https://example.test/v1/dispatches", {
            method: "POST",
            body: JSON.stringify({ deliveryId: "web-invalid", requiredCapacity: 0 })
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handler(
          new Request("https://example.test/v1/dispatches", {
            method: "POST",
            body: JSON.stringify({ deliveryId: "web-missing" })
          })
        )
      ).status
    ).toBe(400)
  })

  test("reports exhausted healthy capacity through go-like readiness", async () => {
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

  test("validates dispatch and courier boundaries and supports deterministic tie breaks", () => {
    expect(() =>
      newMemoryDispatchRepository([{ courierId: "", capacity: 1, healthy: true }])
    ).toThrow("invalid courierId")
    expect(() =>
      newMemoryDispatchRepository([{ courierId: "bad", capacity: 0, healthy: true }])
    ).toThrow("capacity is outside the supported range")
    expect(() =>
      newMemoryDispatchRepository([
        { courierId: "duplicate", capacity: 1, healthy: true },
        { courierId: "duplicate", capacity: 1, healthy: true }
      ])
    ).toThrow("duplicate courierId")

    const repository = newMemoryDispatchRepository([
      { courierId: "zulu", capacity: 4, healthy: true },
      { courierId: "alpha", capacity: 4, healthy: true }
    ])
    const dispatch = newDispatchDelivery(repository)
    expect(() => dispatch(background(), { deliveryId: "", requiredCapacity: 1 })).toThrow(
      "invalid deliveryId"
    )
    for (const requiredCapacity of [0, 1.5, 1_000_001]) {
      expect(() =>
        dispatch(background(), { deliveryId: `invalid-${requiredCapacity}`, requiredCapacity })
      ).toThrow("requiredCapacity is outside the supported range")
    }
    expect(dispatch(background(), { deliveryId: "tie", requiredCapacity: 1 })).toMatchObject({
      courierId: "alpha",
      remainingCapacity: 3
    })
    expect(repository.availableCapacity(background(), "alpha")).toBe(3)
    expect(() => repository.availableCapacity(background(), "missing")).toThrow("courier not found")
  })

  test("rejects already canceled contexts at repository and readiness boundaries", async () => {
    const repository = newMemoryDispatchRepository([
      { courierId: "ctx-courier", capacity: 2, healthy: true }
    ])
    const [ctx, cancel] = withCancel(background())
    cancel()
    expect(() => repository.assign(ctx, { deliveryId: "ctx", requiredCapacity: 1 })).toThrow()
    expect(() => repository.availableCapacity(ctx, "ctx-courier")).toThrow()
    expect(() => repository.checkReady(ctx)).toThrow()
    const service = newDispatchService([{ courierId: "ctx-probe", capacity: 1, healthy: true }])
    expect((await service.probes.check(ctx, "ready")).ok).toBe(false)
  })
})
