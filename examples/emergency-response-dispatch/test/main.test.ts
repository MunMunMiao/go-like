import { background, withCancel } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"
import { describe, expect, test } from "bun:test"

import { newEmergencyResponseService } from "../src/http"

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
