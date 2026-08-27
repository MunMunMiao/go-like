import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import {
  newChargingControlRuntime,
  newMemoryChargingRepository,
  newStartCharging,
  validateChargingStation,
  validateStartCharging
} from "../src/service"

const stations = Object.freeze([
  Object.freeze({ stationId: "station-1", capacityKw: 100, online: true })
])

describe("EV charging control", () => {
  test("never allocates more power than the station capacity", () => {
    const repository = newMemoryChargingRepository(stations)
    const start = newStartCharging(repository)
    start(background(), {
      sessionId: "session-1",
      stationId: "station-1",
      connectorId: "connector-1",
      requestedKw: 60
    })
    expect(() =>
      start(background(), {
        sessionId: "session-2",
        stationId: "station-1",
        connectorId: "connector-2",
        requestedKw: 41
      })
    ).toThrow("station capacity exceeded")
  })

  test("keeps identical session retries idempotent and rejects identity conflicts", () => {
    const repository = newMemoryChargingRepository(stations)
    const start = newStartCharging(repository)
    const command = Object.freeze({
      sessionId: "session-1",
      stationId: "station-1",
      connectorId: "connector-1",
      requestedKw: 20
    })
    const first = start(background(), command)
    expect(start(background(), command)).toBe(first)
    expect(repository.sessionCount()).toBe(1)
    expect(() =>
      start(background(), {
        sessionId: "session-1",
        stationId: "station-1",
        connectorId: "connector-2",
        requestedKw: 20
      })
    ).toThrow("charging session identity conflict")
  })

  test("fails go-like readiness and admission when every station is offline", async () => {
    const runtime = newChargingControlRuntime(stations)
    runtime.repository.setOnline(background(), "station-1", false)
    const report = await runtime.probes.check(background(), "ready")
    expect(report.ok).toBeFalse()
    expect(report.checks[0]?.error?.message).toBe("no charging station is online")

    const response = await runtime.handler(
      new Request("https://example.test/v1/charging-sessions", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-1",
          stationId: "station-1",
          connectorId: "connector-1",
          requestedKw: 20
        })
      })
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "charging_rejected" })
  })

  test("serves one accepted charging session through standard Fetch", async () => {
    const runtime = newChargingControlRuntime(stations)
    const response = await runtime.handler(
      new Request("https://example.test/v1/charging-sessions", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "web-session",
          stationId: "station-1",
          connectorId: "connector-1",
          requestedKw: 20
        })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ status: "charging", requestedKw: 20 })
  })

  test("rejects malformed public requests and routes unknown methods", async () => {
    const runtime = newChargingControlRuntime(stations)
    const notFound = await runtime.handler(
      new Request("https://example.test/v1/charging-sessions", { method: "GET" })
    )
    expect(notFound.status).toBe(404)

    for (const body of ["[]", JSON.stringify({ sessionId: "missing-fields" })]) {
      const response = await runtime.handler(
        new Request("https://example.test/v1/charging-sessions", {
          method: "POST",
          body
        })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "charging_rejected" })
    }
  })

  test("validates station capacity and charging identities before admission", () => {
    expect(() =>
      validateChargingStation({ stationId: "station-1", capacityKw: 0, online: true })
    ).toThrow("capacityKw must be a positive safe integer")
    expect(() =>
      validateStartCharging({
        sessionId: "invalid/id",
        stationId: "station-1",
        connectorId: "connector-1",
        requestedKw: 20
      })
    ).toThrow("invalid charging identity")
    expect(() =>
      validateStartCharging({
        sessionId: "session-1",
        stationId: "station-1",
        connectorId: "connector-1",
        requestedKw: 0
      })
    ).toThrow("requestedKw must be a positive safe integer")
  })
})
