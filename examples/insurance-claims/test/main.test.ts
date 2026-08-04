import { background } from "@go-like/context"
import { newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"
import { newInsuranceClaimsHandler } from "../src/http"
import {
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
})
