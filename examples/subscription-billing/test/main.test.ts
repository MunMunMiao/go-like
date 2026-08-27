import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newSubscriptionBillingService } from "../src/config"
import { newSubscriptionBillingHandler } from "../src/http"
import { newChangeSubscription, newMemoryBillingAdjustmentRepository } from "../src/service"

describe("subscription billing", () => {
  test("charges only the remaining half of an upgraded subscription", () => {
    const change = newChangeSubscription(newMemoryBillingAdjustmentRepository())
    const adjustment = change(background(), {
      requestId: "upgrade-1",
      subscriptionId: "subscription-1",
      oldUnitPriceCents: 1_000,
      newUnitPriceCents: 2_000,
      quantity: 2,
      periodStart: 0,
      periodEnd: 100,
      changedAt: 50
    })
    expect(adjustment.amountCents).toBe(1_000)
    expect(adjustment.remainingMilliseconds).toBe(50)
  })

  test("rounds a prorated downgrade away from zero", () => {
    const change = newChangeSubscription(newMemoryBillingAdjustmentRepository())
    expect(
      change(background(), {
        requestId: "downgrade-1",
        subscriptionId: "subscription-1",
        oldUnitPriceCents: 3_000,
        newUnitPriceCents: 1_000,
        quantity: 1,
        periodStart: 0,
        periodEnd: 3,
        changedAt: 2
      }).amountCents
    ).toBe(-667)
  })

  test("rejects invalid subscription boundaries and covers deterministic rounding cases", () => {
    const change = newChangeSubscription(newMemoryBillingAdjustmentRepository())
    const valid = {
      requestId: "valid-1",
      subscriptionId: "subscription-1",
      oldUnitPriceCents: 1_000,
      newUnitPriceCents: 2_000,
      quantity: 1,
      periodStart: 0,
      periodEnd: 100,
      changedAt: 50
    }
    expect(() => change(background(), { ...valid, requestId: "bad id" })).toThrow(
      "invalid requestId"
    )
    expect(() => change(background(), { ...valid, subscriptionId: "bad id" })).toThrow(
      "invalid subscriptionId"
    )
    expect(() => change(background(), { ...valid, oldUnitPriceCents: -1 })).toThrow(
      "unit prices must be non-negative safe integers"
    )
    expect(() => change(background(), { ...valid, quantity: 0 })).toThrow(
      "quantity must be a positive safe integer"
    )
    expect(() => change(background(), { ...valid, changedAt: 0 })).toThrow(
      "changedAt must be inside the billing period"
    )
    expect(
      change(background(), {
        ...valid,
        requestId: "round-down",
        oldUnitPriceCents: 0,
        newUnitPriceCents: 1,
        periodEnd: 3,
        changedAt: 2
      }).amountCents
    ).toBe(0)
    expect(
      change(background(), {
        ...valid,
        requestId: "round-up",
        oldUnitPriceCents: 0,
        newUnitPriceCents: 2,
        periodEnd: 3,
        changedAt: 2
      }).amountCents
    ).toBe(1)
  })

  test("deduplicates retries and rejects a conflicting request identity", () => {
    const change = newChangeSubscription(newMemoryBillingAdjustmentRepository())
    const command = Object.freeze({
      requestId: "same",
      subscriptionId: "subscription-1",
      oldUnitPriceCents: 1_000,
      newUnitPriceCents: 2_000,
      quantity: 1,
      periodStart: 0,
      periodEnd: 100,
      changedAt: 50
    })
    expect(change(background(), command)).toBe(change(background(), command))
    expect(() =>
      change(background(), {
        requestId: "same",
        subscriptionId: "subscription-1",
        oldUnitPriceCents: 1_000,
        newUnitPriceCents: 3_000,
        quantity: 1,
        periodStart: 0,
        periodEnd: 100,
        changedAt: 50
      })
    ).toThrow("idempotency conflict")
  })

  test("maps invalid requests, wrong routes, and domain failures to stable responses", async () => {
    const change = newChangeSubscription(newMemoryBillingAdjustmentRepository())
    const handler = newSubscriptionBillingHandler(change)
    expect((await handler(new Request("https://example.test/wrong"))).status).toBe(404)
    const invalid = await handler(
      new Request("https://example.test/v1/subscription-changes", {
        method: "POST",
        body: JSON.stringify(null)
      })
    )
    expect(invalid.status).toBe(400)
    const invalidFields = await handler(
      new Request("https://example.test/v1/subscription-changes", {
        method: "POST",
        body: JSON.stringify({ requestId: "request-1" })
      })
    )
    expect(invalidFields.status).toBe(400)
    const rejected = newSubscriptionBillingHandler(() => {
      throw new Error("billing dependency failed")
    })
    const response = await rejected(
      new Request("https://example.test/v1/subscription-changes", {
        method: "POST",
        body: JSON.stringify({
          requestId: "web-1",
          subscriptionId: "subscription-1",
          oldUnitPriceCents: 1_000,
          newUnitPriceCents: 2_000,
          quantity: 1,
          periodStart: 0,
          periodEnd: 100,
          changedAt: 25
        })
      })
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: "subscription_change_rejected",
      message: "billing dependency failed"
    })
  })

  test("serves the billing rule through a standard Fetch handler", async () => {
    const response = await newSubscriptionBillingHandler(
      newChangeSubscription(newMemoryBillingAdjustmentRepository())
    )(
      new Request("https://example.test/v1/subscription-changes", {
        method: "POST",
        body: JSON.stringify({
          requestId: "web-1",
          subscriptionId: "subscription-1",
          oldUnitPriceCents: 1_000,
          newUnitPriceCents: 2_000,
          quantity: 1,
          periodStart: 0,
          periodEnd: 100,
          changedAt: 25
        })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ amountCents: 750 })
  })

  test("rejects an invalid loaded adjustment ceiling", async () => {
    const service = newSubscriptionBillingService({
      maximumAdjustmentCents: 0
    })
    await service.config.load(background())
    try {
      expect(() =>
        service.change(background(), {
          requestId: "invalid-policy",
          subscriptionId: "subscription-1",
          oldUnitPriceCents: 1_000,
          newUnitPriceCents: 2_000,
          quantity: 1,
          periodStart: 0,
          periodEnd: 100,
          changedAt: 25
        })
      ).toThrow("maximumAdjustmentCents must be a positive safe integer")
    } finally {
      await service.config.close(background())
    }
  })

  test("returns an adjustment that stays within the configured ceiling", async () => {
    const service = newSubscriptionBillingService({
      maximumAdjustmentCents: 1_000
    })
    await service.config.load(background())
    try {
      expect(
        service.change(background(), {
          requestId: "within-ceiling",
          subscriptionId: "subscription-1",
          oldUnitPriceCents: 1_000,
          newUnitPriceCents: 2_000,
          quantity: 1,
          periodStart: 0,
          periodEnd: 100,
          changedAt: 25
        })
      ).toMatchObject({ amountCents: 750 })
    } finally {
      await service.config.close(background())
    }
  })

  test("loads Config and applies its adjustment ceiling", async () => {
    const service = newSubscriptionBillingService({
      maximumAdjustmentCents: 500
    })
    await service.config.load(background())
    try {
      expect(service.config.value("maximumAdjustmentCents").load()).toBe(500)
      const response = await newSubscriptionBillingHandler(service.change)(
        new Request("https://example.test/v1/subscription-changes", {
          method: "POST",
          body: JSON.stringify({
            requestId: "configured-1",
            subscriptionId: "subscription-1",
            oldUnitPriceCents: 1_000,
            newUnitPriceCents: 2_000,
            quantity: 1,
            periodStart: 0,
            periodEnd: 100,
            changedAt: 25
          })
        })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        message: "billing adjustment exceeds configured maximum"
      })
    } finally {
      await service.config.close(background())
    }
  })
})
