import { newMemoryCache } from "@go-like/cache-memory"
import { background } from "@go-like/context"
import { circuitOpen, newCircuitBreaker } from "@go-like/resilience"
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

  test("falls back to scoring when persisted cache data is malformed", async () => {
    const cache = newMemoryCache()
    const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 })
    const assess = newCachedAssessTransaction(
      cache,
      breaker,
      newAssessTransaction(newMemoryFraudSignalsRepository({}))
    )
    const malformedEntries = [
      "not-json",
      "null",
      JSON.stringify({ fingerprint: 42, assessment: {} }),
      JSON.stringify({ fingerprint: "fingerprint", assessment: null }),
      JSON.stringify({
        fingerprint: "fingerprint",
        assessment: { transactionId: "ignored", score: 0, decision: "unknown", reasons: [] }
      }),
      JSON.stringify({
        fingerprint: "fingerprint",
        assessment: { transactionId: "ignored", score: 0, decision: "approve", reasons: [1] }
      })
    ]

    for (const [index, entry] of malformedEntries.entries()) {
      const transactionId = `malformed-${index}`
      const command = Object.freeze({
        transactionId,
        accountId: "account-1",
        amountMinor: 1_000,
        country: "DE",
        homeCountry: "DE",
        deviceTrusted: true
      })
      await cache.put(
        background(),
        `fraud-assessment:v1:${transactionId}`,
        new TextEncoder().encode(entry)
      )
      await expect(assess(background(), command)).resolves.toMatchObject({
        transactionId,
        score: 0,
        decision: "approve"
      })
    }
  })

  test("rejects malformed requests and reports public Fetch failures", async () => {
    const command = {
      transactionId: "web-invalid",
      accountId: "account-1",
      amountMinor: 1_000,
      country: "DE",
      homeCountry: "DE",
      deviceTrusted: true
    }
    const handler = newFraudRiskHandler(newAssessTransaction(newMemoryFraudSignalsRepository({})))

    const notFound = await handler(new Request("https://example.test/v1/other", { method: "GET" }))
    expect(notFound.status).toBe(404)

    const malformed = await handler(
      new Request("https://example.test/v1/risk-assessments", {
        method: "POST",
        body: JSON.stringify({ transactionId: "missing-fields" })
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      code: "risk_assessment_rejected",
      message: "invalid transaction assessment"
    })

    const typeFailure = await newFraudRiskHandler(function rejectWithTypeError(): never {
      throw new TypeError("invalid dependency input")
    })(
      new Request("https://example.test/v1/risk-assessments", {
        method: "POST",
        body: JSON.stringify(command)
      })
    )
    expect(typeFailure.status).toBe(400)

    const unknownFailure = await newFraudRiskHandler(function rejectWithUnknown(): never {
      throw "dependency unavailable"
    })(
      new Request("https://example.test/v1/risk-assessments", {
        method: "POST",
        body: JSON.stringify(command)
      })
    )
    expect(unknownFailure.status).toBe(409)
    expect(await unknownFailure.json()).toEqual({
      code: "risk_assessment_rejected",
      message: "assessment failed"
    })
  })

  test("rejects invalid cache TTLs, transaction amounts and server-side velocity signals", () => {
    expect(() =>
      newCachedAssessTransaction(
        newMemoryCache(),
        newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 }),
        newAssessTransaction(newMemoryFraudSignalsRepository({})),
        0
      )
    ).toThrow("fraud assessment cache ttl must be a positive safe integer")

    const command = {
      transactionId: "invalid-amount",
      accountId: "account-1",
      amountMinor: 0,
      country: "DE",
      homeCountry: "DE",
      deviceTrusted: true
    }
    expect(() =>
      newAssessTransaction(newMemoryFraudSignalsRepository({}))(background(), command)
    ).toThrow("amountMinor is outside the supported range")

    const invalidSignals = newAssessTransaction(
      newMemoryFraudSignalsRepository({
        "invalid-signals": Object.freeze({
          transactionsLastFiveMinutes: -1,
          declinedLastHour: 0
        })
      })
    )
    expect(() =>
      invalidSignals(background(), {
        transactionId: "invalid-signals-transaction",
        accountId: "invalid-signals",
        amountMinor: 1_000,
        country: "DE",
        homeCountry: "DE",
        deviceTrusted: true
      })
    ).toThrow("invalid server-side velocity signals")
  })
})
