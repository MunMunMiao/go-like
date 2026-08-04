import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import {
  newHandler,
  newListFreshArrivals,
  newMemoryArrivalRepository,
  newPublishArrival,
  newRuntime
} from "../src/service"

describe("public transit arrivals", () => {
  test("returns only predictions inside the requested freshness window", () => {
    const repository = newMemoryArrivalRepository()
    const publish = newPublishArrival(repository)
    const listFresh = newListFreshArrivals(repository)
    publish(background(), {
      stopId: "stop-1",
      vehicleId: "fresh",
      observedAt: 9_500,
      arrivalAt: 12_000
    })
    publish(background(), {
      stopId: "stop-1",
      vehicleId: "stale",
      observedAt: 8_000,
      arrivalAt: 11_000
    })
    expect(listFresh(background(), { stopId: "stop-1", now: 10_000, maxAgeMs: 1_000 })).toEqual([
      {
        stopId: "stop-1",
        vehicleId: "fresh",
        observedAt: 9_500,
        arrivalAt: 12_000
      }
    ])
  })

  test("keeps the latest observation per stop and vehicle", () => {
    const repository = newMemoryArrivalRepository()
    const publish = newPublishArrival(repository)
    const listFresh = newListFreshArrivals(repository)
    publish(background(), {
      stopId: "stop-2",
      vehicleId: "bus-7",
      observedAt: 5_000,
      arrivalAt: 9_000
    })
    publish(background(), {
      stopId: "stop-2",
      vehicleId: "bus-7",
      observedAt: 6_000,
      arrivalAt: 8_000
    })
    expect(listFresh(background(), { stopId: "stop-2", now: 6_500, maxAgeMs: 2_000 })).toHaveLength(
      1
    )
    expect(
      listFresh(background(), { stopId: "stop-2", now: 6_500, maxAgeMs: 2_000 })[0]
    ).toMatchObject({ observedAt: 6_000, arrivalAt: 8_000 })
  })

  test("rejects a late observation that would overwrite newer data", () => {
    const publish = newPublishArrival(newMemoryArrivalRepository())
    publish(background(), {
      stopId: "stop-3",
      vehicleId: "train-1",
      observedAt: 7_000,
      arrivalAt: 9_000
    })
    expect(() =>
      publish(background(), {
        stopId: "stop-3",
        vehicleId: "train-1",
        observedAt: 6_000,
        arrivalAt: 8_500
      })
    ).toThrow("stale observation")
  })

  test("publishes and reads arrivals through a standard Fetch handler", async () => {
    const handler = newHandler()
    const publishResponse = await handler(
      new Request("https://example.test/v1/arrival-predictions", {
        method: "POST",
        body: JSON.stringify({
          stopId: "web-stop",
          vehicleId: "web-bus",
          observedAt: 10_000,
          arrivalAt: 12_000
        })
      })
    )
    expect(publishResponse.status).toBe(201)
    const queryResponse = await handler(
      new Request("https://example.test/v1/stops/web-stop/arrivals?now=10500&maxAgeMs=1000")
    )
    expect(queryResponse.status).toBe(200)
    expect(await queryResponse.json()).toEqual({
      arrivals: [
        {
          stopId: "web-stop",
          vehicleId: "web-bus",
          observedAt: 10_000,
          arrivalAt: 12_000
        }
      ]
    })
  })

  test("reports prediction-feed freshness through go-like readiness", async () => {
    const runtime = newRuntime(() => 10_000, 1_000)
    expect((await runtime.probes.check(background(), "ready")).ok).toBe(false)
    await runtime.handler(
      new Request("https://example.test/v1/arrival-predictions", {
        method: "POST",
        body: JSON.stringify({
          stopId: "probe-stop",
          vehicleId: "probe-bus",
          observedAt: 9_500,
          arrivalAt: 12_000
        })
      })
    )
    expect((await runtime.probes.check(background(), "ready")).ok).toBe(true)
  })
})
