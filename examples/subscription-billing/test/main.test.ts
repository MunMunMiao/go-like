import { background } from "@likego/context"
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
