import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newMaintenanceHandler } from "../src/http"
import {
  newHandler,
  newMemoryMaintenanceRepository,
  newProcessMaintenanceSignal,
  newRuntime,
  validateMaintenanceSignal
} from "../src/service"

describe("manufacturing maintenance", () => {
  test("creates only one work order inside a continuous fault window", () => {
    const process = newProcessMaintenanceSignal(newMemoryMaintenanceRepository())
    const first = process(background(), {
      signalId: "signal-1",
      machineId: "press-7",
      kind: "fault",
      faultCode: "overheat",
      occurredAt: 1_000
    })
    const repeated = process(background(), {
      signalId: "signal-2",
      machineId: "press-7",
      kind: "fault",
      faultCode: "overheat",
      occurredAt: 1_100
    })
    expect(first.created).toBe(true)
    expect(repeated.created).toBe(false)
    expect(repeated.activeWorkOrderId).toBe(first.activeWorkOrderId)
  })

  test("opens a new work order only after recovery closes the window", () => {
    const process = newProcessMaintenanceSignal(newMemoryMaintenanceRepository())
    const first = process(background(), {
      signalId: "signal-a",
      machineId: "lathe-2",
      kind: "fault",
      faultCode: "vibration",
      occurredAt: 2_000
    })
    expect(
      process(background(), {
        signalId: "signal-b",
        machineId: "lathe-2",
        kind: "recovered",
        faultCode: null,
        occurredAt: 2_100
      }).activeWorkOrderId
    ).toBeNull()
    const second = process(background(), {
      signalId: "signal-c",
      machineId: "lathe-2",
      kind: "fault",
      faultCode: "vibration",
      occurredAt: 2_200
    })
    expect(second.created).toBe(true)
    expect(second.activeWorkOrderId).not.toBe(first.activeWorkOrderId)
  })

  test("deduplicates a signal and rejects conflicting identity reuse", () => {
    const process = newProcessMaintenanceSignal(newMemoryMaintenanceRepository())
    const signal = Object.freeze({
      signalId: "same",
      machineId: "mill-1",
      kind: "fault",
      faultCode: "jammed",
      occurredAt: 3_000
    })
    expect(process(background(), signal)).toEqual(process(background(), signal))
    expect(() =>
      process(background(), {
        signalId: "same",
        machineId: "mill-2",
        kind: "fault",
        faultCode: "jammed",
        occurredAt: 3_000
      })
    ).toThrow("signal identity conflict")
  })

  test("serves machine signals through a standard Fetch handler", async () => {
    const response = await newHandler()(
      new Request("https://example.test/v1/maintenance-signals", {
        method: "POST",
        body: JSON.stringify({
          signalId: "web-1",
          machineId: "welder-4",
          kind: "fault",
          faultCode: "arc-loss",
          occurredAt: 4_000
        })
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      machineId: "welder-4",
      activeWorkOrderId: "wo-welder-4-1",
      created: true
    })
  })

  test("checks the maintenance repository through go-like readiness", async () => {
    const report = await newRuntime().probes.check(background(), "ready")
    expect(report.ok).toBe(true)
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]?.name).toBe("maintenance_repository")
  })

  test("validates signal shape and ordering before changing the window", () => {
    const validRecovery = {
      signalId: "recovery-1",
      machineId: "press-7",
      kind: "recovered" as const,
      faultCode: null,
      occurredAt: 1_000
    }
    expect(() => validateMaintenanceSignal(validRecovery)).not.toThrow()
    expect(() => validateMaintenanceSignal({ ...validRecovery, signalId: "bad id" })).toThrow(
      "invalid signalId"
    )
    expect(() => validateMaintenanceSignal({ ...validRecovery, machineId: "bad id" })).toThrow(
      "invalid machineId"
    )
    expect(() => validateMaintenanceSignal({ ...validRecovery, occurredAt: -1 })).toThrow(
      "invalid occurredAt"
    )
    expect(() =>
      validateMaintenanceSignal({ ...validRecovery, kind: "fault", faultCode: null })
    ).toThrow("faultCode is required for fault")
    expect(() =>
      validateMaintenanceSignal({ ...validRecovery, kind: "fault", faultCode: "bad code" })
    ).toThrow("faultCode is required for fault")
    expect(() => validateMaintenanceSignal({ ...validRecovery, faultCode: "unexpected" })).toThrow(
      "faultCode must be null for recovery"
    )

    const process = newProcessMaintenanceSignal(newMemoryMaintenanceRepository())
    process(background(), {
      signalId: "ordered-1",
      machineId: "press-7",
      kind: "fault",
      faultCode: "overheat",
      occurredAt: 2_000
    })
    expect(() =>
      process(background(), {
        signalId: "ordered-2",
        machineId: "press-7",
        kind: "recovered",
        faultCode: null,
        occurredAt: 1_999
      })
    ).toThrow("out-of-order signal")
  })

  test("maps HTTP not-found, malformed and domain failures to stable responses", async () => {
    const handler = newMaintenanceHandler(
      newProcessMaintenanceSignal(newMemoryMaintenanceRepository())
    )
    const notFound = await handler(new Request("https://example.test/other"))
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ code: "not_found" })

    const malformed = await handler(
      new Request("https://example.test/v1/maintenance-signals", {
        method: "POST",
        body: JSON.stringify({ signalId: "bad" })
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      code: "maintenance_signal_rejected",
      message: "invalid maintenance signal"
    })

    await handler(
      new Request("https://example.test/v1/maintenance-signals", {
        method: "POST",
        body: JSON.stringify({
          signalId: "ordered-http-1",
          machineId: "press-7",
          kind: "fault",
          faultCode: "overheat",
          occurredAt: 2_000
        })
      })
    )
    const rejected = await handler(
      new Request("https://example.test/v1/maintenance-signals", {
        method: "POST",
        body: JSON.stringify({
          signalId: "late",
          machineId: "press-7",
          kind: "recovered",
          faultCode: null,
          occurredAt: 1
        })
      })
    )
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      code: "maintenance_signal_rejected",
      message: "out-of-order signal"
    })
  })
})
