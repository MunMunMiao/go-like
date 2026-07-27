import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"
import { newDisruptionHandler } from "../src/http"
import { newMemoryDisruptionRepository, newResolveDisruption } from "../src/service"

describe("airline irregular operations", () => {
  test("keeps repeated rebooking decisions idempotent", () => {
    const resolve = newResolveDisruption(newMemoryDisruptionRepository())
    const command = Object.freeze({ caseId: "case-1", outcome: "rebooked" })
    expect(resolve(background(), command)).toEqual(resolve(background(), command))
  })

  test("allows exactly one terminal outcome", () => {
    const resolve = newResolveDisruption(newMemoryDisruptionRepository())
    expect(resolve(background(), { caseId: "case-2", outcome: "refunded" })).toMatchObject({
      status: "resolved",
      outcome: "refunded"
    })
    expect(() => resolve(background(), { caseId: "case-2", outcome: "rebooked" })).toThrow(
      "disruption already resolved"
    )
  })

  test("isolates terminal decisions by disruption case", () => {
    const resolve = newResolveDisruption(newMemoryDisruptionRepository())
    expect(resolve(background(), { caseId: "case-a", outcome: "rebooked" }).outcome).toBe(
      "rebooked"
    )
    expect(resolve(background(), { caseId: "case-b", outcome: "refunded" }).outcome).toBe(
      "refunded"
    )
  })

  test("round-robins rebooking work across discovered service instances", () => {
    const resolve = newResolveDisruption(
      newMemoryDisruptionRepository([
        {
          id: "provider-a",
          name: "rebooking",
          version: "v1",
          endpoints: ["https://provider-a.example.test/"],
          metadata: {}
        },
        {
          id: "provider-b",
          name: "rebooking",
          version: "v1",
          endpoints: ["https://provider-b.example.test/"],
          metadata: {}
        }
      ])
    )
    expect(
      resolve(background(), { caseId: "selector-a", outcome: "rebooked" }).providerEndpoint
    ).toBe("https://provider-a.example.test/")
    expect(
      resolve(background(), { caseId: "selector-b", outcome: "rebooked" }).providerEndpoint
    ).toBe("https://provider-b.example.test/")
  })

  test("serves resolution through a standard Fetch handler", async () => {
    const response = await newDisruptionHandler(
      newResolveDisruption(newMemoryDisruptionRepository())
    )(
      new Request("https://example.test/v1/disruptions/resolve", {
        method: "POST",
        body: JSON.stringify({ caseId: "web-1", outcome: "rebooked" })
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      caseId: "web-1",
      outcome: "rebooked",
      status: "resolved",
      providerEndpoint: "https://rebooking-a.example.test/"
    })
  })
})
