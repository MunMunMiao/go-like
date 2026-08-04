import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import type { CampaignDefinition } from "../src/campaigns"
import { newAdCampaignService } from "../src/service"

const campaigns: readonly CampaignDefinition[] = Object.freeze([
  Object.freeze({
    id: "campaign-low",
    placement: "home",
    audienceSegments: Object.freeze(["sports"]),
    creativeId: "creative-low",
    bidMinor: 20,
    budgetMinor: 100,
    active: true
  }),
  Object.freeze({
    id: "campaign-high",
    placement: "home",
    audienceSegments: Object.freeze(["sports"]),
    creativeId: "creative-high",
    bidMinor: 30,
    budgetMinor: 60,
    active: true
  }),
  Object.freeze({
    id: "campaign-inactive",
    placement: "home",
    audienceSegments: Object.freeze(["sports"]),
    creativeId: "creative-inactive",
    bidMinor: 100,
    budgetMinor: 1_000,
    active: false
  })
])

const creatives = Object.freeze({
  "creative-low": "<ad>low</ad>",
  "creative-high": "<ad>high</ad>",
  "creative-inactive": "<ad>inactive</ad>"
})

describe("ad campaign serving", () => {
  test("chooses the highest eligible bid and never serves inactive campaigns", async () => {
    const service = newAdCampaignService(campaigns, creatives)
    const response = await service.handler(
      new Request("https://example.test/v1/ads:serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "request-1",
          placement: "home",
          audienceSegment: "sports"
        })
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      campaignId: "campaign-high",
      chargedMinor: 30,
      remainingBudgetMinor: 30
    })
  })

  test("charges one idempotent request once and caches its creative", async () => {
    const service = newAdCampaignService(campaigns, creatives)
    const body = JSON.stringify({
      requestId: "stable",
      placement: "home",
      audienceSegment: "sports"
    })
    const first = await service.handler(
      new Request("https://example.test/v1/ads:serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      })
    )
    const second = await service.handler(
      new Request("https://example.test/v1/ads:serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      })
    )
    expect(await first.json()).toEqual(await second.json())
    expect(service.remainingBudget(background(), "campaign-high")).toBe(30)
    expect(service.creativeLoads()).toBe(1)
  })

  test("does not consume budget when the creative fails behind the circuit breaker", async () => {
    const missingCreativeCampaign: readonly CampaignDefinition[] = Object.freeze([
      Object.freeze({
        id: "missing",
        placement: "feed",
        audienceSegments: Object.freeze(["all"]),
        creativeId: "not-found",
        bidMinor: 15,
        budgetMinor: 45,
        active: true
      })
    ])
    const service = newAdCampaignService(missingCreativeCampaign, Object.freeze({}))
    const response = await service.handler(
      new Request("https://example.test/v1/ads:serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "missing-creative",
          placement: "feed",
          audienceSegment: "all"
        })
      })
    )
    expect(response.status).toBe(503)
    expect(service.remainingBudget(background(), "missing")).toBe(45)
    expect(service.circuitState()).toBe("open")
  })

  test("rejects traffic beyond the go-like token-bucket admission capacity", async () => {
    const service = newAdCampaignService(campaigns, creatives, 1)
    const first = await service.handler(
      new Request("https://example.test/v1/ads:serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "allowed",
          placement: "home",
          audienceSegment: "sports"
        })
      })
    )
    const limited = await service.handler(
      new Request("https://example.test/v1/ads:serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "limited",
          placement: "home",
          audienceSegment: "sports"
        })
      })
    )
    expect(first.status).toBe(200)
    expect(limited.status).toBe(429)
  })
})
