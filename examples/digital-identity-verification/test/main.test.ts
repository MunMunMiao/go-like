import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newDigitalIdentityService } from "../src/http"
import { newMemoryIdentityProvider } from "../src/provider"

const verifiedDigest = "a".repeat(64)
const reviewDigest = "b".repeat(64)

describe("digital identity verification", () => {
  test("returns only the minimized result from an allowed provider", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "trusted-eu",
      decisionsByDigest: { [verifiedDigest]: "verified" }
    })
    const service = newDigitalIdentityService({
      providers: [provider],
      allowedProviderIds: ["trusted-eu"],
      timeoutMs: 100
    })
    const response = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify({
          requestId: "request-1",
          applicantReference: "applicant-opaque-1",
          providerId: "trusted-eu",
          documentDigest: verifiedDigest
        })
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      requestId: "request-1",
      applicantReference: "applicant-opaque-1",
      providerId: "trusted-eu",
      decision: "verified"
    })
    expect(provider.calls()).toBe(1)
  })

  test("deduplicates exact retries and rejects conflicting request identities", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "trusted-eu",
      decisionsByDigest: {
        [verifiedDigest]: "verified",
        [reviewDigest]: "review"
      }
    })
    const service = newDigitalIdentityService({
      providers: [provider],
      allowedProviderIds: ["trusted-eu"],
      timeoutMs: 100
    })
    const request = Object.freeze({
      requestId: "same",
      applicantReference: "applicant-1",
      providerId: "trusted-eu",
      documentDigest: verifiedDigest
    })
    const first = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify(request)
      })
    )
    const retry = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify(request)
      })
    )
    expect(await retry.json()).toEqual(await first.json())
    expect(provider.calls()).toBe(1)

    const conflict = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify({
          requestId: "same",
          applicantReference: "applicant-1",
          providerId: "trusted-eu",
          documentDigest: reviewDigest
        })
      })
    )
    expect(conflict.status).toBe(409)
    expect(provider.calls()).toBe(1)
  })

  test("rejects a provider outside the explicit allowlist before outbound work", async () => {
    const allowed = newMemoryIdentityProvider({
      providerId: "trusted-eu",
      decisionsByDigest: {}
    })
    const blocked = newMemoryIdentityProvider({
      providerId: "untrusted",
      decisionsByDigest: {}
    })
    const service = newDigitalIdentityService({
      providers: [allowed, blocked],
      allowedProviderIds: ["trusted-eu"],
      timeoutMs: 100
    })
    const response = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify({
          requestId: "blocked-1",
          applicantReference: "applicant-1",
          providerId: "untrusted",
          documentDigest: verifiedDigest
        })
      })
    )
    expect(response.status).toBe(400)
    expect(allowed.calls()).toBe(0)
    expect(blocked.calls()).toBe(0)
  })

  test("bounds provider latency without counting caller timeout as breaker failure", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "slow",
      decisionsByDigest: {},
      latencyMs: 30
    })
    const service = newDigitalIdentityService({
      providers: [provider],
      allowedProviderIds: ["slow"],
      timeoutMs: 1,
      failureThreshold: 1
    })
    const response = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify({
          requestId: "timeout-1",
          applicantReference: "applicant-1",
          providerId: "slow",
          documentDigest: verifiedDigest
        })
      })
    )
    expect(response.status).toBe(503)
    expect(service.circuitState("slow")).toBe("closed")
  })

  test("reports unavailable readiness and opens the provider Circuit Breaker", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "offline",
      decisionsByDigest: {},
      available: false
    })
    const service = newDigitalIdentityService({
      providers: [provider],
      allowedProviderIds: ["offline"],
      timeoutMs: 100,
      failureThreshold: 1
    })
    const readiness = await service.health(new Request("https://example.test/readyz"))
    expect(readiness.status).toBe(503)

    const response = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: JSON.stringify({
          requestId: "offline-1",
          applicantReference: "applicant-1",
          providerId: "offline",
          documentDigest: verifiedDigest
        })
      })
    )
    expect(response.status).toBe(503)
    expect(service.circuitState("offline")).toBe("open")
  })
})
