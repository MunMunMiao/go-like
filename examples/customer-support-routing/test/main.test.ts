import { background, withCancel } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"
import { describe, expect, test } from "bun:test"

import { newSupportRoutingHandler } from "../src/http"
import { newMemorySupportRoutingStore } from "../src/routing"
import { newRouteSupportCase, validateSupportCase } from "../src/service"

describe("customer-support routing", () => {
  test("keeps each language inside its matching skill pool", () => {
    const route = newRouteSupportCase(newMemorySupportRoutingStore())
    expect(
      route(background(), { caseId: "case-zh", language: "zh", priority: "standard" }).agentEndpoint
    ).toContain("zh-")
    expect(
      route(background(), { caseId: "case-en", language: "en", priority: "standard" }).agentEndpoint
    ).toContain("en-")
  })

  test("routes urgent work only to senior agents", () => {
    const route = newRouteSupportCase(newMemorySupportRoutingStore())
    const assignment = route(background(), {
      caseId: "case-urgent",
      language: "zh",
      priority: "urgent"
    })
    expect(assignment.agentLevel).toBe("senior")
    expect(assignment.agentEndpoint).toBe("https://zh-senior.example.test/")
  })

  test("keeps exact retries stable and rejects changed criteria", () => {
    const route = newRouteSupportCase(newMemorySupportRoutingStore())
    const command = Object.freeze({
      caseId: "case-stable",
      language: "en",
      priority: "standard"
    })
    const first = route(background(), command)
    expect(route(background(), command)).toEqual(first)
    expect(() =>
      route(background(), { caseId: "case-stable", language: "en", priority: "urgent" })
    ).toThrow("support case already assigned with different routing criteria")
  })

  test("fails closed when no agent satisfies the route", () => {
    const agents: readonly ServiceInstance[] = Object.freeze([
      Object.freeze({
        id: "agent-zh",
        name: "customer-support",
        version: "v1",
        endpoints: Object.freeze(["https://zh-only.example.test/"]),
        metadata: Object.freeze({ language: "zh", level: "standard" })
      })
    ])
    const route = newRouteSupportCase(newMemorySupportRoutingStore(agents))
    expect(() =>
      route(background(), { caseId: "case-missing", language: "en", priority: "urgent" })
    ).toThrow("no eligible support agent")
  })

  test("serves routing through a standard Fetch handler", async () => {
    const handler = newSupportRoutingHandler(newRouteSupportCase(newMemorySupportRoutingStore()))
    const response = await handler(
      new Request("https://example.test/v1/support/cases/route", {
        method: "POST",
        body: JSON.stringify({ caseId: "case-http", language: "zh", priority: "urgent" })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      caseId: "case-http",
      language: "zh",
      priority: "urgent",
      agentLevel: "senior"
    })
  })

  test("validates support commands, context cancellation, and handler errors", async () => {
    const valid = { caseId: "case.valid", language: "en", priority: "standard" } as const
    expect(validateSupportCase(valid)).toBeUndefined()
    expect(() => validateSupportCase({ ...valid, caseId: "" })).toThrow("invalid caseId")
    expect(() => validateSupportCase({ ...valid, language: "fr" as never })).toThrow(
      "unsupported support language"
    )
    expect(() => validateSupportCase({ ...valid, priority: "low" as never })).toThrow(
      "unsupported support priority"
    )

    const [ctx, cancel] = withCancel(background())
    cancel()
    expect(() => newMemorySupportRoutingStore().assign(ctx, valid)).toThrow()

    const handler = newSupportRoutingHandler(newRouteSupportCase(newMemorySupportRoutingStore()))
    const requests: Array<[Request, number]> = [
      [new Request("https://example.test/other", { method: "GET" }), 404],
      [
        new Request("https://example.test/v1/support/cases/route", {
          method: "POST",
          body: JSON.stringify([])
        }),
        400
      ],
      [
        new Request("https://example.test/v1/support/cases/route", {
          method: "POST",
          body: JSON.stringify({ caseId: "case-invalid", language: "fr", priority: "standard" })
        }),
        400
      ]
    ]
    for (const [request, status] of requests) expect((await handler(request)).status).toBe(status)

    const unavailable = newSupportRoutingHandler(
      newRouteSupportCase(
        newMemorySupportRoutingStore([
          {
            id: "agent-zh",
            name: "customer-support",
            version: "v1",
            endpoints: ["https://zh-only.example.test/"],
            metadata: { language: "zh", level: "standard" }
          }
        ])
      )
    )
    const noAgent = await unavailable(
      new Request("https://example.test/v1/support/cases/route", {
        method: "POST",
        body: JSON.stringify({ caseId: "case-no-agent", language: "en", priority: "urgent" })
      })
    )
    expect(noAgent.status).toBe(503)
    expect(await noAgent.json()).toMatchObject({ code: "support_routing_rejected" })

    const conflictRoute = newRouteSupportCase(newMemorySupportRoutingStore())
    conflictRoute(background(), { caseId: "case-conflict", language: "en", priority: "standard" })
    const conflictHandler = newSupportRoutingHandler(conflictRoute)
    const conflict = await conflictHandler(
      new Request("https://example.test/v1/support/cases/route", {
        method: "POST",
        body: JSON.stringify({ caseId: "case-conflict", language: "en", priority: "urgent" })
      })
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: "support_routing_rejected" })
  })
})
