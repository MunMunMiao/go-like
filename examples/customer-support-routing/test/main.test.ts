import { background } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"
import { describe, expect, test } from "bun:test"

import { newSupportRoutingHandler } from "../src/http"
import { newMemorySupportRoutingStore } from "../src/routing"
import { newRouteSupportCase } from "../src/service"

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
})
