import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newArrivalHandler } from "../src/http"
import {
  arrivalFingerprint,
  newHandler,
  newListFreshArrivals,
  newMemoryArrivalRepository,
  newPublishArrival,
  newRuntime,
  validateArrivalPrediction,
  validateArrivalQuery
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

  test("validates prediction and query boundaries", () => {
    expect(
      arrivalFingerprint({ stopId: "stop", vehicleId: "bus", observedAt: 1, arrivalAt: 2 })
    ).toBe("1\u00002")
    expect(() =>
      validateArrivalPrediction({ stopId: "bad id", vehicleId: "bus", observedAt: 1, arrivalAt: 2 })
    ).toThrow("invalid stopId")
    expect(() =>
      validateArrivalPrediction({
        stopId: "stop",
        vehicleId: "bad id",
        observedAt: 1,
        arrivalAt: 2
      })
    ).toThrow("invalid vehicleId")
    expect(() =>
      validateArrivalPrediction({ stopId: "stop", vehicleId: "bus", observedAt: -1, arrivalAt: 2 })
    ).toThrow("invalid prediction timestamps")
    expect(() =>
      validateArrivalPrediction({ stopId: "stop", vehicleId: "bus", observedAt: 2, arrivalAt: 1 })
    ).toThrow("invalid prediction timestamps")
    expect(() => validateArrivalQuery({ stopId: "bad id", now: 1, maxAgeMs: 1 })).toThrow(
      "invalid stopId"
    )
    expect(() => validateArrivalQuery({ stopId: "stop", now: -1, maxAgeMs: 1 })).toThrow(
      "invalid query time"
    )
    expect(() => validateArrivalQuery({ stopId: "stop", now: 1, maxAgeMs: 0 })).toThrow(
      "maxAgeMs is outside the supported range"
    )
    expect(() => validateArrivalQuery({ stopId: "stop", now: 1, maxAgeMs: 86_400_001 })).toThrow(
      "maxAgeMs is outside the supported range"
    )
  })

  test("rejects equal-time conflicts and invalid readiness windows", () => {
    const publish = newPublishArrival(newMemoryArrivalRepository())
    const original = publish(background(), {
      stopId: "stop-4",
      vehicleId: "bus-4",
      observedAt: 4_000,
      arrivalAt: 5_000
    })
    expect(
      publish(background(), {
        stopId: "stop-4",
        vehicleId: "bus-4",
        observedAt: 4_000,
        arrivalAt: 5_000
      })
    ).toBe(original)
    expect(() =>
      publish(background(), {
        stopId: "stop-4",
        vehicleId: "bus-4",
        observedAt: 4_000,
        arrivalAt: 5_100
      })
    ).toThrow("observation identity conflict")
    const repository = newMemoryArrivalRepository()
    expect(() => repository.checkFeedFreshness(background(), -1, 1)).toThrow("invalid probe time")
    expect(() => repository.checkFeedFreshness(background(), 1, 0)).toThrow(
      "invalid probe freshness window"
    )
    expect(() => repository.checkFeedFreshness(background(), 1, 1)).toThrow(
      "arrival prediction feed is stale"
    )
    const stale = newMemoryArrivalRepository()
    newPublishArrival(stale)(background(), {
      stopId: "stale-stop",
      vehicleId: "bus",
      observedAt: 1,
      arrivalAt: 2
    })
    expect(() => stale.checkFeedFreshness(background(), 3, 1)).toThrow(
      "arrival prediction feed is stale"
    )
    const fresh = newMemoryArrivalRepository()
    const publishFresh = newPublishArrival(fresh)
    publishFresh(background(), {
      stopId: "fresh-stop",
      vehicleId: "bus",
      observedAt: 1,
      arrivalAt: 10
    })
    expect(() => fresh.checkFeedFreshness(background(), 1, 1)).not.toThrow()
    const ordered = newMemoryArrivalRepository()
    const publishOrdered = newPublishArrival(ordered)
    publishOrdered(background(), {
      stopId: "sort-stop",
      vehicleId: "zeta",
      observedAt: 1,
      arrivalAt: 10
    })
    publishOrdered(background(), {
      stopId: "sort-stop",
      vehicleId: "alpha",
      observedAt: 1,
      arrivalAt: 10
    })
    expect(
      ordered
        .listFresh(background(), { stopId: "sort-stop", now: 1, maxAgeMs: 1 })
        .map((item) => item.vehicleId)
    ).toEqual(["alpha", "zeta"])
  })

  test("covers Fetch rejection and deterministic arrival ordering", async () => {
    const published: Array<{
      stopId: string
      vehicleId: string
      observedAt: number
      arrivalAt: number
    }> = []
    const handler = newArrivalHandler(
      (_ctx, prediction) => {
        published.push(prediction)
        return prediction
      },
      (_ctx, query) => [
        { stopId: query.stopId, vehicleId: "z-last", observedAt: query.now, arrivalAt: query.now },
        { stopId: query.stopId, vehicleId: "a-first", observedAt: query.now, arrivalAt: query.now }
      ]
    )
    const invalidBody = await handler(
      new Request("https://example.test/v1/arrival-predictions", {
        method: "POST",
        body: JSON.stringify({ stopId: "stop", vehicleId: "bus", observedAt: 1 })
      })
    )
    expect(invalidBody.status).toBe(400)
    expect(await invalidBody.json()).toMatchObject({ code: "arrival_operation_rejected" })
    const missingQuery = await handler(
      new Request("https://example.test/v1/stops/stop/arrivals?now=1")
    )
    expect(missingQuery.status).toBe(400)
    const notFound = await handler(new Request("https://example.test/other"))
    expect(notFound.status).toBe(404)
    const valid = await handler(
      new Request("https://example.test/v1/arrival-predictions", {
        method: "POST",
        body: JSON.stringify({ stopId: "stop", vehicleId: "bus", observedAt: 1, arrivalAt: 2 })
      })
    )
    expect(valid.status).toBe(201)
    expect(published).toHaveLength(1)
    const ordered = await handler(
      new Request("https://example.test/v1/stops/stop/arrivals?now=2&maxAgeMs=1")
    )
    expect(ordered.status).toBe(200)
    expect(await ordered.json()).toEqual({
      arrivals: [
        { stopId: "stop", vehicleId: "z-last", observedAt: 2, arrivalAt: 2 },
        { stopId: "stop", vehicleId: "a-first", observedAt: 2, arrivalAt: 2 }
      ]
    })
    const malformedJson = await handler(
      new Request("https://example.test/v1/arrival-predictions", {
        method: "POST",
        body: "not-json"
      })
    )
    expect(malformedJson.status).toBe(409)
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
