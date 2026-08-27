import { background, withCancel } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newIrrigationHandler } from "../src/http"
import { newIrrigationConfig } from "../src/irrigation-config"
import {
  decideIrrigation,
  validateIrrigationCommand,
  validateIrrigationPolicy
} from "../src/irrigation-policy"
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

  test("rejects invalid sensor commands and policies", () => {
    expect(() =>
      validateIrrigationCommand({
        fieldId: "bad field",
        soilMoisturePercent: 20,
        observedAt: 1,
        requestedLiters: 1
      })
    ).toThrow("invalid fieldId")
    expect(() =>
      validateIrrigationCommand({
        fieldId: "field-1",
        soilMoisturePercent: 101,
        observedAt: 1,
        requestedLiters: 1
      })
    ).toThrow("soilMoisturePercent must be between 0 and 100")
    expect(() =>
      validateIrrigationCommand({
        fieldId: "field-1",
        soilMoisturePercent: 20,
        observedAt: -1,
        requestedLiters: 1
      })
    ).toThrow("observedAt must be a non-negative safe integer")
    expect(() =>
      validateIrrigationCommand({
        fieldId: "field-1",
        soilMoisturePercent: 20,
        observedAt: 1,
        requestedLiters: 0
      })
    ).toThrow("requestedLiters must be a positive safe integer")
    expect(() => validateIrrigationPolicy({ ...policy, triggerBelowPercent: 101 })).toThrow(
      "triggerBelowPercent must be between 0 and 100"
    )
    expect(() => validateIrrigationPolicy({ ...policy, maxReadingAgeMs: -1 })).toThrow(
      "maxReadingAgeMs must be a non-negative safe integer"
    )
    expect(() => validateIrrigationPolicy({ ...policy, maxLiters: 0 })).toThrow(
      "maxLiters must be a positive safe integer"
    )
    expect(() =>
      decideIrrigation(
        {
          fieldId: "field-1",
          soilMoisturePercent: 20,
          observedAt: 1,
          requestedLiters: 1
        },
        policy,
        -1
      )
    ).toThrow("now must be valid")
  })

  test("rejects invalid policy snapshots and canceled scheduling contexts", () => {
    const invalidShape = {
      value() {
        return { load: () => null }
      }
    } as never
    const invalidSchedule = newScheduleIrrigation(invalidShape)
    expect(() =>
      invalidSchedule(background(), {
        fieldId: "field-1",
        soilMoisturePercent: 20,
        observedAt: 1,
        requestedLiters: 1
      })
    ).toThrow("irrigation configuration is invalid")

    const invalidFields = {
      value() {
        return { load: () => ({ triggerBelowPercent: 35, maxReadingAgeMs: 5_000 }) }
      }
    } as never
    const invalidFieldSchedule = newScheduleIrrigation(invalidFields)
    expect(() =>
      invalidFieldSchedule(background(), {
        fieldId: "field-1",
        soilMoisturePercent: 20,
        observedAt: 1,
        requestedLiters: 1
      })
    ).toThrow("irrigation configuration is invalid")

    const [canceled, cancel] = withCancel(background())
    cancel()
    expect(() =>
      newScheduleIrrigation(invalidFields)(canceled, {
        fieldId: "field-1",
        soilMoisturePercent: 20,
        observedAt: 1,
        requestedLiters: 1
      })
    ).toThrow("context canceled")
  })

  test("maps public request and scheduling failures to stable responses", async () => {
    const valid = {
      fieldId: "field-1",
      soilMoisturePercent: 20,
      observedAt: 9_000,
      requestedLiters: 10
    }
    const notFound = await newIrrigationHandler(() => ({
      fieldId: "field-1",
      status: "scheduled",
      liters: 10
    }))(new Request("https://example.test/wrong"))
    expect(notFound.status).toBe(404)

    const invalidBody = await newIrrigationHandler(() => ({
      fieldId: "field-1",
      status: "scheduled",
      liters: 10
    }))(
      new Request("https://example.test/v1/irrigation-decisions", { method: "POST", body: "null" })
    )
    expect(invalidBody.status).toBe(400)

    const invalidCommand = await newIrrigationHandler(() => ({
      fieldId: "field-1",
      status: "scheduled",
      liters: 10
    }))(
      new Request("https://example.test/v1/irrigation-decisions", {
        method: "POST",
        body: JSON.stringify({ ...valid, soilMoisturePercent: "dry" })
      })
    )
    expect(invalidCommand.status).toBe(400)

    const invalidReading = await newIrrigationHandler(() => {
      throw new RangeError("sensor reading outside policy")
    })(
      new Request("https://example.test/v1/irrigation-decisions", {
        method: "POST",
        body: JSON.stringify(valid)
      })
    )
    expect(invalidReading.status).toBe(400)

    const rejected = await newIrrigationHandler(() => {
      throw new Error("manual irrigation rejection")
    })(
      new Request("https://example.test/v1/irrigation-decisions", {
        method: "POST",
        body: JSON.stringify(valid)
      })
    )
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      code: "irrigation_rejected",
      message: "manual irrigation rejection"
    })

    const unknownFailure = await newIrrigationHandler(() => {
      throw "non-error failure"
    })(
      new Request("https://example.test/v1/irrigation-decisions", {
        method: "POST",
        body: JSON.stringify(valid)
      })
    )
    expect(unknownFailure.status).toBe(409)
    expect(await unknownFailure.json()).toMatchObject({
      code: "irrigation_rejected",
      message: "irrigation decision failed"
    })
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
