import { background } from "@go-like/context"
import { newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"
import { newInsuranceClaimsHandler } from "../src/http"
import {
  decideClaim,
  newInsuranceClaimsService,
  newMemoryClaimsRepository,
  newSubmitClaim
} from "../src/service"

const policy = Object.freeze({
  policyId: "policy-1",
  startsAt: 1_000,
  endsAt: 10_000,
  deductibleCents: 100,
  coverageLimitCents: 1_000
})

describe("insurance claims", () => {
  test("applies a deductible and caps aggregate payouts at the policy limit", () => {
    const submit = newSubmitClaim(newMemoryClaimsRepository([policy]))
    expect(
      submit(background(), {
        claimId: "claim-1",
        policyId: "policy-1",
        incidentAt: 2_000,
        lossCents: 700
      })
    ).toMatchObject({ payableCents: 600, remainingCoverageCents: 400 })
    expect(
      submit(background(), {
        claimId: "claim-2",
        policyId: "policy-1",
        incidentAt: 3_000,
        lossCents: 700
      })
    ).toMatchObject({ payableCents: 400, remainingCoverageCents: 0 })
  })

  test("returns no payout when a loss does not exceed the deductible", () => {
    const submit = newSubmitClaim(newMemoryClaimsRepository([policy]))
    expect(
      submit(background(), {
        claimId: "small-claim",
        policyId: "policy-1",
        incidentAt: 2_000,
        lossCents: 100
      })
    ).toMatchObject({ payableCents: 0, status: "belowDeductible" })
  })

  test("rejects incidents outside coverage and conflicting claim identities", () => {
    const submit = newSubmitClaim(newMemoryClaimsRepository([policy]))
    expect(() =>
      submit(background(), {
        claimId: "outside",
        policyId: "policy-1",
        incidentAt: 10_000,
        lossCents: 500
      })
    ).toThrow("incident outside policy period")
    const accepted = Object.freeze({
      claimId: "same",
      policyId: "policy-1",
      incidentAt: 2_000,
      lossCents: 500
    })
    expect(submit(background(), accepted)).toBe(submit(background(), accepted))
    expect(() =>
      submit(background(), {
        claimId: "same",
        policyId: "policy-1",
        incidentAt: 2_000,
        lossCents: 600
      })
    ).toThrow("claim identity conflict")
  })

  test("serves claim submission through a standard Fetch handler", async () => {
    const response = await newInsuranceClaimsHandler(
      newSubmitClaim(newMemoryClaimsRepository([policy]))
    )(
      new Request("https://example.test/v1/claims", {
        method: "POST",
        body: JSON.stringify({
          claimId: "web-1",
          policyId: "policy-1",
          incidentAt: 2_000,
          lossCents: 500
        })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ payableCents: 400, status: "approved" })
  })

  test("lets Core own the structural claims review worker lifecycle", async () => {
    const service = newInsuranceClaimsService([policy])
    expect(service.worker.diagnostics()).toEqual({
      status: "idle",
      starts: 0,
      stops: 0
    })

    const app = newApp(server(service.worker.server))
    const running = app.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(service.worker.diagnostics()).toEqual({
      status: "running",
      starts: 1,
      stops: 0
    })

    await app.stop()
    await running
    expect(service.worker.diagnostics()).toEqual({
      status: "stopped",
      starts: 1,
      stops: 1
    })
  })

  test("returns the limit-exhausted decision and rejects invalid policy setup", () => {
    const exhausted = newSubmitClaim(
      newMemoryClaimsRepository([
        Object.freeze({
          ...policy,
          deductibleCents: 0,
          coverageLimitCents: 100
        })
      ])
    )
    expect(
      exhausted(background(), {
        claimId: "exhausted",
        policyId: "policy-1",
        incidentAt: 2_000,
        lossCents: 100
      })
    ).toMatchObject({ payableCents: 100, remainingCoverageCents: 0, status: "approved" })
    expect(
      exhausted(background(), {
        claimId: "limit-exhausted",
        policyId: "policy-1",
        incidentAt: 3_000,
        lossCents: 10
      })
    ).toMatchObject({ payableCents: 0, remainingCoverageCents: 0, status: "limitExhausted" })

    expect(() =>
      newMemoryClaimsRepository([Object.freeze({ ...policy, policyId: "invalid policy" })])
    ).toThrow("invalid policyId")
    expect(() =>
      newMemoryClaimsRepository([Object.freeze({ ...policy, startsAt: 5_000, endsAt: 5_000 })])
    ).toThrow("invalid policy period")
    expect(() =>
      newMemoryClaimsRepository([Object.freeze({ ...policy, deductibleCents: -1 })])
    ).toThrow("invalid policy money limits")
    expect(() => newMemoryClaimsRepository([policy, Object.freeze({ ...policy })])).toThrow(
      "duplicate policyId"
    )
    expect(() =>
      decideClaim(
        {
          claimId: "bad-aggregate",
          policyId: "policy-1",
          incidentAt: 2_000,
          lossCents: 100
        },
        policy,
        policy.coverageLimitCents + 1
      )
    ).toThrow("invalid paid aggregate")
  })

  test("rejects invalid claims and unknown policy operations", () => {
    const submit = newSubmitClaim(newMemoryClaimsRepository([policy]))
    expect(() =>
      submit(background(), {
        claimId: "bad id",
        policyId: "policy-1",
        incidentAt: 2_000,
        lossCents: 500
      })
    ).toThrow("invalid claimId")
    expect(() =>
      submit(background(), {
        claimId: "bad-policy",
        policyId: "unknown-policy",
        incidentAt: 2_000,
        lossCents: 500
      })
    ).toThrow("unknown policy")
    expect(() =>
      submit(background(), {
        claimId: "bad-time",
        policyId: "policy-1",
        incidentAt: Number.NaN,
        lossCents: 500
      })
    ).toThrow("invalid incidentAt")
    expect(() =>
      submit(background(), {
        claimId: "bad-loss",
        policyId: "policy-1",
        incidentAt: 2_000,
        lossCents: 0
      })
    ).toThrow("lossCents must be a positive safe integer")
  })

  test("reports malformed Fetch requests and not-found routes", async () => {
    const handler = newInsuranceClaimsHandler(newSubmitClaim(newMemoryClaimsRepository([policy])))
    const malformed = await handler(
      new Request("https://example.test/v1/claims", {
        method: "POST",
        body: JSON.stringify({ claimId: "missing" })
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      code: "claim_rejected",
      message: "invalid claim"
    })

    const notFound = await handler(new Request("https://example.test/v1/other", { method: "GET" }))
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ code: "not_found" })
  })
})
