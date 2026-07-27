import { newMemoryCache } from "@likego/cache-memory"
import { background } from "@likego/context"
import { circuitOpen, newCircuitBreaker } from "@likego/resilience"
import { describe, expect, test } from "bun:test"
import { newCachedAssessTransaction, newFraudRiskMicroservice } from "../src/cache"
import { newFraudRiskHandler } from "../src/http"
import { newAssessTransaction, newMemoryFraudSignalsRepository } from "../src/service"

describe("fraud risk scoring", () => {
  test("approves a low-risk transaction with no triggered reasons", () => {
    const assess = newAssessTransaction(newMemoryFraudSignalsRepository({}))
    expect(
      assess(background(), {
        transactionId: "transaction-1",
        accountId: "constructor",
        amountMinor: 1_000,
        country: "DE",
        homeCountry: "DE",
        deviceTrusted: true
      })
    ).toEqual({
      transactionId: "transaction-1",
      score: 0,
      decision: "approve",
      reasons: []
    })
  })

  test("caps a multi-signal fraud score at 100 and declines it", () => {
    const assess = newAssessTransaction(
      newMemoryFraudSignalsRepository({
        "account-1": Object.freeze({
          transactionsLastFiveMinutes: 4,
          declinedLastHour: 2
        })
      })
    )
    const assessment = assess(background(), {
      transactionId: "transaction-2",
      accountId: "account-1",
      amountMinor: 200_000,
      country: "US",
      homeCountry: "DE",
      deviceTrusted: false
    })
    expect(assessment.score).toBe(100)
    expect(assessment.decision).toBe("decline")
    expect(assessment.reasons).toHaveLength(5)
  })

  test("returns one stable assessment and rejects conflicting transaction reuse", () => {
    const assess = newAssessTransaction(newMemoryFraudSignalsRepository({}))
    const command = Object.freeze({
      transactionId: "same",
      accountId: "account-1",
      amountMinor: 1_000,
      country: "DE",
      homeCountry: "DE",
      deviceTrusted: true
    })
    expect(assess(background(), command)).toBe(assess(background(), command))
    expect(() =>
      assess(background(), {
        transactionId: "same",
        accountId: "account-1",
        amountMinor: 2_000,
        country: "DE",
        homeCountry: "DE",
        deviceTrusted: true
      })
    ).toThrow("transaction identity conflict")
  })

  test("serves an assessment through a standard Fetch handler", async () => {
    const response = await newFraudRiskHandler(
      newAssessTransaction(newMemoryFraudSignalsRepository({}))
    )(
      new Request("https://example.test/v1/risk-assessments", {
        method: "POST",
        body: JSON.stringify({
          transactionId: "web-1",
          accountId: "account-1",
          amountMinor: 120_000,
          country: "DE",
          homeCountry: "DE",
          deviceTrusted: true
        })
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ score: 25, decision: "approve" })
  })

  test("caches a scored transaction and preserves its request identity", async () => {
    const service = newFraudRiskMicroservice({})
    const command = Object.freeze({
      transactionId: "cached-1",
      accountId: "account-1",
      amountMinor: 120_000,
      country: "DE",
      homeCountry: "DE",
      deviceTrusted: true
    })
    const first = await service.assess(background(), command)
    expect(await service.cache.get(background(), "fraud-assessment:v1:cached-1")).not.toBeNull()
    expect(await service.assess(background(), command)).toEqual(first)
    expect(service.breaker.snapshot().state).toBe("closed")
    await expect(
      service.assess(background(), {
        transactionId: "cached-1",
        accountId: "account-1",
        amountMinor: 130_000,
        country: "DE",
        homeCountry: "DE",
        deviceTrusted: true
      })
    ).rejects.toThrow("transaction identity conflict")
  })

  test("opens the Circuit Breaker after a failed scoring dependency", async () => {
    const cache = newMemoryCache()
    const breaker = newCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 60_000
    })
    const assess = newCachedAssessTransaction(cache, breaker, function unavailable(): never {
      throw new Error("signals unavailable")
    })
    const command = Object.freeze({
      transactionId: "failure-1",
      accountId: "account-1",
      amountMinor: 1_000,
      country: "DE",
      homeCountry: "DE",
      deviceTrusted: true
    })
    await expect(assess(background(), command)).rejects.toThrow("signals unavailable")
    expect(breaker.snapshot().state).toBe("open")
    await expect(assess(background(), command)).rejects.toBe(circuitOpen)
  })
})
