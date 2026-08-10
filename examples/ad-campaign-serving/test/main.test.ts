import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newMemoryCampaignRepository } from "../src/ad-resources"
import {
  adRequestFingerprint,
  campaignEligible,
  validateAdRequest,
  validateCampaign,
  type AdRequest,
  type CampaignDefinition
} from "../src/campaigns"
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

  test("validates public campaign and request boundaries", () => {
    const request: AdRequest = {
      requestId: "request:valid",
      placement: "home-page",
      audienceSegment: "sports_1"
    }
    expect(validateAdRequest(request)).toBeUndefined()
    expect(adRequestFingerprint(request)).toBe("home-page\u0000sports_1")
    expect(campaignEligible(campaigns[0]!, request, 20)).toBe(false)
    expect(() => validateAdRequest({ ...request, requestId: "" })).toThrow("invalid requestId")
    expect(() => validateAdRequest({ ...request, placement: "bad placement" })).toThrow(
      "invalid placement"
    )
    expect(() => validateAdRequest({ ...request, audienceSegment: "" })).toThrow(
      "invalid audienceSegment"
    )
    expect(() =>
      validateCampaign({ ...campaigns[0]!, id: "", placement: "home", creativeId: "creative-low" })
    ).toThrow("invalid campaign id")
    expect(() => validateCampaign({ ...campaigns[0]!, placement: "bad placement" })).toThrow(
      "invalid campaign placement"
    )
    expect(() => validateCampaign({ ...campaigns[0]!, creativeId: "" })).toThrow(
      "invalid creativeId"
    )
    expect(() => validateCampaign({ ...campaigns[0]!, bidMinor: 0 })).toThrow(
      "bidMinor must be a positive safe integer"
    )
    expect(() => validateCampaign({ ...campaigns[0]!, budgetMinor: -1 })).toThrow(
      "budgetMinor must be a non-negative safe integer"
    )
    expect(() => validateCampaign({ ...campaigns[0]!, audienceSegments: [] })).toThrow(
      "campaign requires at least one audience segment"
    )
    expect(() => validateCampaign({ ...campaigns[0]!, audienceSegments: ["bad segment"] })).toThrow(
      "invalid campaign audience segment"
    )
  })

  test("protects repository budgets, snapshots definitions, and rejects conflicts", () => {
    const original = {
      id: "snapshot",
      placement: "home",
      audienceSegments: ["sports"],
      creativeId: "creative-low",
      bidMinor: 10,
      budgetMinor: 20,
      active: true
    }
    const repository = newMemoryCampaignRepository([original])
    original.audienceSegments[0] = "changed"
    const request = { requestId: "repo-1", placement: "home", audienceSegment: "sports" }
    const selected = repository.select(background(), request)
    expect(selected.audienceSegments).toEqual(["sports"])
    expect(repository.commit(background(), request, selected.id)).toMatchObject({
      remainingBudgetMinor: 10
    })
    expect(repository.commit(background(), request, selected.id)).toEqual(
      repository.commit(background(), request, selected.id)
    )
    expect(() => repository.select(background(), { ...request, audienceSegment: "other" })).toThrow(
      "idempotency conflict"
    )
    expect(() =>
      repository.commit(background(), { ...request, audienceSegment: "other" }, selected.id)
    ).toThrow("idempotency conflict")
    expect(() =>
      repository.select(background(), { ...request, requestId: "no-match", placement: "unknown" })
    ).toThrow("no eligible campaign")
    expect(() =>
      repository.commit(background(), { ...request, requestId: "unknown-request" }, "unknown")
    ).toThrow("unknown campaign")
    expect(
      repository.commit(
        background(),
        { requestId: "repo-2", placement: "home", audienceSegment: "sports" },
        selected.id
      )
    ).toMatchObject({
      remainingBudgetMinor: 0
    })
    expect(() =>
      repository.commit(
        background(),
        { requestId: "repo-3", placement: "home", audienceSegment: "sports" },
        selected.id
      )
    ).toThrow("campaign is no longer eligible")
    expect(() => newMemoryCampaignRepository([original, original])).toThrow("duplicate campaign id")
  })

  test("maps malformed requests and routing failures to Fetch responses", async () => {
    const service = newAdCampaignService(campaigns, creatives)
    const cases: Array<[Request, number, string]> = [
      [new Request("https://example.test/other", { method: "GET" }), 404, "not_found"],
      [
        new Request("https://example.test/v1/ads:serve", {
          method: "POST",
          body: JSON.stringify(null)
        }),
        400,
        "invalid JSON body"
      ],
      [
        new Request("https://example.test/v1/ads:serve", {
          method: "POST",
          body: JSON.stringify({
            requestId: "bad request",
            placement: "home",
            audienceSegment: "sports"
          })
        }),
        400,
        "invalid requestId"
      ],
      [
        new Request("https://example.test/v1/ads:serve", {
          method: "POST",
          body: JSON.stringify({ requestId: "missing-fields" })
        }),
        400,
        "invalid ad request"
      ],
      [
        new Request("https://example.test/v1/ads:serve", {
          method: "POST",
          body: JSON.stringify({
            requestId: "no-campaign",
            placement: "unknown",
            audienceSegment: "sports"
          })
        }),
        409,
        "no eligible campaign"
      ]
    ]
    for (const [request, status, message] of cases) {
      const response = await service.handler(request)
      expect(response.status).toBe(status)
      const body = await response.json()
      if (status === 404) expect(body).toEqual({ code: "not_found" })
      else expect(body).toMatchObject({ code: "ad_not_served", message })
    }
  })
})
