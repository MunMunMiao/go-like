import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"

import { newIrrigationHandler } from "../src/http"
import { newIrrigationConfig } from "../src/irrigation-config"
import { decideIrrigation } from "../src/irrigation-policy"
import { newScheduleIrrigation } from "../src/service"

const policy = Object.freeze({
  triggerBelowPercent: 35,
  maxReadingAgeMs: 5_000,
  maxLiters: 100
})

describe("smart agriculture irrigation", () => {
  test("fails closed for stale and future sensor observations", () => {
    expect(() =>
      decideIrrigation(
        {
          fieldId: "field-1",
          soilMoisturePercent: 20,
          observedAt: 4_999,
          requestedLiters: 50
        },
        policy,
        10_000
      )
    ).toThrow("sensor observation is stale")
    expect(() =>
      decideIrrigation(
        {
          fieldId: "field-1",
          soilMoisturePercent: 20,
          observedAt: 10_001,
          requestedLiters: 50
        },
        policy,
        10_000
      )
    ).toThrow("sensor observation is from the future")
  })

  test("does not irrigate a sufficiently moist field", () => {
    expect(
      decideIrrigation(
        {
          fieldId: "field-1",
          soilMoisturePercent: 35,
          observedAt: 9_000,
          requestedLiters: 50
        },
        policy,
        10_000
      )
    ).toEqual({ fieldId: "field-1", status: "notNeeded", liters: 0 })
  })

  test("caps a dry field decision at the configured water limit", () => {
    expect(
      decideIrrigation(
        {
          fieldId: "field-1",
          soilMoisturePercent: 20,
          observedAt: 9_000,
          requestedLiters: 150
        },
        policy,
        10_000
      )
    ).toEqual({ fieldId: "field-1", status: "scheduled", liters: 100 })
  })

  test("serves a fresh decision through Config and standard Fetch", async () => {
    const config = newIrrigationConfig(policy)
    const handler = newIrrigationHandler(newScheduleIrrigation(config, () => 10_000))
    await config.load(background())
    try {
      const response = await handler(
        new Request("https://example.test/v1/irrigation-decisions", {
          method: "POST",
          body: JSON.stringify({
            fieldId: "field-1",
            soilMoisturePercent: 20,
            observedAt: 9_000,
            requestedLiters: 80
          })
        })
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        fieldId: "field-1",
        status: "scheduled",
        liters: 80
      })
    } finally {
      await config.close(background())
    }
  })
})
