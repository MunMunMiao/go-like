import { background, withCancel } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"
import { describe, expect, test } from "bun:test"

import { newEmergencyDispatchHandler, newEmergencyResponseService } from "../src/http"
import {
  newMemoryEmergencyDispatchRepository,
  newRegistryResponderDirectory
} from "../src/dispatch"
import {
  dispatchFingerprint,
  isEmergencyPriority,
  isEmergencyService,
  prioritySlaMs,
  validateDispatchCommand
} from "../src/service"

const responders: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "medical-north-a",
    name: "emergency-responder",
    version: "v1",
    endpoints: Object.freeze(["https://medical-north-a.example.test/dispatch"]),
    metadata: Object.freeze({
      zone: "north",
      service: "medical",
      readiness: "ready"
    })
  }),
  Object.freeze({
    id: "medical-north-b",
    name: "emergency-responder",
    version: "v1",
    endpoints: Object.freeze(["https://medical-north-b.example.test/dispatch"]),
    metadata: Object.freeze({
      zone: "north",
      service: "medical",
      readiness: "ready"
    })
  }),
  Object.freeze({
    id: "medical-north-draining",
    name: "emergency-responder",
    version: "v1",
    endpoints: Object.freeze(["https://medical-north-draining.example.test/dispatch"]),
    metadata: Object.freeze({
      zone: "north",
      service: "medical",
      readiness: "draining"
    })
  }),
  Object.freeze({
    id: "fire-south",
    name: "emergency-responder",
    version: "v1",
    endpoints: Object.freeze(["https://fire-south.example.test/dispatch"]),
    metadata: Object.freeze({
      zone: "south",
      service: "fire",
      readiness: "ready"
    })
  })
])

describe("emergency response dispatch", () => {
  test("routes malformed requests and maps typed, conflict, and operational failures", async () => {
    for (const request of [
      new Request("https://example.test/v1/emergency-dispatches", { method: "GET" }),
      new Request("https://example.test/other", { method: "POST", body: "{}" })
    ]) {
      const response = await newEmergencyDispatchHandler(() => {
        throw new Error("dispatch must not run")
      })(request)
      expect(response.status).toBe(404)
    }
    for (const body of [
      "[]",
      JSON.stringify({ incidentId: "incident-1" }),
      JSON.stringify({
        incidentId: "incident-1",
        service: "unknown",
        zone: "north",
        priority: "urgent",
        reportedAt: 1,
        dispatchBy: 2
      })
    ]) {
      const response = await newEmergencyDispatchHandler(() => {
        throw new Error("dispatch must not run")
      })(
        new Request("https://example.test/v1/emergency-dispatches", {
          method: "POST",
          body
        })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "emergency_dispatch_rejected" })
    }
    const command = {
      incidentId: "incident-failure",
      service: "medical",
      zone: "north",
      priority: "urgent",
      reportedAt: 1,
      dispatchBy: 2
    }
    for (const [failure, status] of [
      [new TypeError("invalid incidentId"), 400],
      [new RangeError("expired"), 400],
      [new Error("incident dispatch conflict"), 409],
      [new Error("registry unavailable"), 503],
      ["opaque dispatch failure", 503]
    ] as const) {
      const response = await newEmergencyDispatchHandler(() => {
        throw failure
      })(
        new Request("https://example.test/v1/emergency-dispatches", {
          method: "POST",
          body: JSON.stringify(command)
        })
      )
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code: "emergency_dispatch_rejected" })
    }
  })

  test("validates emergency predicates, deadlines, and fingerprints", () => {
    expect(isEmergencyService("fire")).toBeTrue()
    expect(isEmergencyService("other")).toBeFalse()
    expect(isEmergencyPriority("critical")).toBeTrue()
    expect(isEmergencyPriority("other")).toBeFalse()
    expect(prioritySlaMs("critical")).toBe(300_000)
    expect(prioritySlaMs("urgent")).toBe(900_000)
    const command = {
      incidentId: "incident-1",
      service: "medical" as const,
      zone: "north",
      priority: "urgent" as const,
      reportedAt: 1_000,
      dispatchBy: 2_000
    }
    expect(dispatchFingerprint(command)).toBe("7:medical5:north6:urgent1000:2000")
    for (const invalid of [
      { ...command, incidentId: "bad/id" },
      { ...command, zone: "bad zone" },
      { ...command, service: "other" as never },
      { ...command, priority: "other" as never }
    ]) {
      expect(() => validateDispatchCommand(invalid, 2_000)).toThrow()
    }
    expect(() => validateDispatchCommand(command, -1)).toThrow("invalid clock")
    expect(() => validateDispatchCommand({ ...command, reportedAt: 3_000 }, 2_000)).toThrow(
      "future"
    )
    expect(() =>
      validateDispatchCommand({ ...command, dispatchBy: Number.MAX_SAFE_INTEGER + 1 }, 2_000)
    ).toThrow("expired")
    expect(() => validateDispatchCommand({ ...command, dispatchBy: 1_000 }, 2_000)).toThrow(
      "expired"
    )
    expect(() => validateDispatchCommand({ ...command, dispatchBy: 902_000 }, 2_000)).toThrow(
      "exceeds"
    )
    const nearLimit = Number.MAX_SAFE_INTEGER - 1_000
    expect(() =>
      validateDispatchCommand(
        {
          ...command,
          reportedAt: nearLimit,
          dispatchBy: nearLimit + 500
        },
        nearLimit
      )
    ).toThrow("exceeds")
  })

  test("assigns one critical incident only to a matching ready responder", async () => {
    const service = newEmergencyResponseService(responders, () => 1_000)
    const response = await service.handler(
      new Request("https://example.test/v1/emergency-dispatches", {
        method: "POST",
        body: JSON.stringify({
          incidentId: "incident-1",
          service: "medical",
          zone: "north",
          priority: "critical",
          reportedAt: 500,
          dispatchBy: 2_000
        })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      incidentId: "incident-1",
      priority: "critical",
      responderId: "medical-north-a",
      endpoint: "https://medical-north-a.example.test/dispatch",
      dispatchBy: 2_000,
      status: "assigned"
    })
  })

  test("enforces priority SLA, elapsed deadline and caller cancellation", () => {
    const service = newEmergencyResponseService(responders, () => 1_000_000)
    expect(() =>
      service.dispatch(background(), {
        incidentId: "critical-too-late",
        service: "medical",
        zone: "north",
        priority: "critical",
        reportedAt: 900_000,
        dispatchBy: 1_300_001
      })
    ).toThrow("critical dispatch exceeds its response SLA")
    expect(() =>
      service.dispatch(background(), {
        incidentId: "expired",
        service: "medical",
        zone: "north",
        priority: "urgent",
        reportedAt: 900_000,
        dispatchBy: 1_000_000
      })
    ).toThrow("dispatch deadline has expired")

    const canceled = withCancel(background())
    canceled[1]()
    expect(() =>
      service.dispatch(canceled[0], {
        incidentId: "canceled",
        service: "medical",
        zone: "north",
        priority: "urgent",
        reportedAt: 900_000,
        dispatchBy: 1_100_000
      })
    ).toThrow("context canceled")
  })

  test("rotates registry endpoints while keeping an exact retry stable", () => {
    const service = newEmergencyResponseService(responders, () => 1_000)
    const firstCommand = Object.freeze({
      incidentId: "incident-1",
      service: "medical",
      zone: "north",
      priority: "urgent",
      reportedAt: 500,
      dispatchBy: 2_000
    })
    const first = service.dispatch(background(), firstCommand)
    expect(first.responderId).toBe("medical-north-a")
    expect(service.dispatch(background(), firstCommand)).toBe(first)
    expect(() =>
      service.dispatch(background(), {
        ...firstCommand,
        dispatchBy: 2_001
      })
    ).toThrow("incident dispatch conflict")
    expect(
      service.dispatch(background(), {
        incidentId: "incident-2",
        service: "medical",
        zone: "north",
        priority: "urgent",
        reportedAt: 500,
        dispatchBy: 2_000
      }).responderId
    ).toBe("medical-north-b")
  })

  test("keeps repository records idempotent and rejects direct identity conflicts", () => {
    const repository = newMemoryEmergencyDispatchRepository()
    const command = {
      incidentId: "repository-incident",
      service: "medical" as const,
      zone: "north",
      priority: "urgent" as const,
      reportedAt: 500,
      dispatchBy: 2_000
    }
    const dispatch = {
      incidentId: command.incidentId,
      priority: command.priority,
      responderId: "responder-a",
      endpoint: "https://responder.example.test/dispatch",
      dispatchBy: command.dispatchBy,
      status: "assigned" as const
    }
    expect(repository.get(background(), command.incidentId)).toBeNull()
    expect(repository.save(background(), command, dispatch)).toBe(dispatch)
    expect(repository.save(background(), command, dispatch)).toBe(dispatch)
    expect(() =>
      repository.save(background(), { ...command, dispatchBy: 2_001 }, dispatch)
    ).toThrow("incident dispatch conflict")
  })

  test("rejects a canceled responder directory before selector work", () => {
    const directory = newRegistryResponderDirectory(responders)
    const canceled = withCancel(background())
    canceled[1]()
    expect(() =>
      directory.select(canceled[0], {
        incidentId: "canceled-directory",
        service: "medical",
        zone: "north",
        priority: "urgent",
        reportedAt: 500,
        dispatchBy: 2_000
      })
    ).toThrow("context canceled")
  })

  test("fails closed when registry metadata yields no eligible responder", async () => {
    const service = newEmergencyResponseService(responders, () => 1_000)
    const response = await service.handler(
      new Request("https://example.test/v1/emergency-dispatches", {
        method: "POST",
        body: JSON.stringify({
          incidentId: "incident-fire-north",
          service: "fire",
          zone: "north",
          priority: "urgent",
          reportedAt: 500,
          dispatchBy: 2_000
        })
      })
    )
    expect(response.status).toBe(503)
  })
})
