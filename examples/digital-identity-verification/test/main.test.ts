import { background, withCancel } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newDigitalIdentityService, newIdentityVerificationHandler } from "../src/http"
import {
  newMemoryIdentityProvider,
  newMemoryIdentityVerificationRepository,
  newResilientIdentityProviderGateway
} from "../src/provider"
import { validateIdentityCommand } from "../src/service"

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

  test("rejects invalid HTTP routes and command shapes before provider work", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "trusted-eu",
      decisionsByDigest: {}
    })
    const service = newDigitalIdentityService({
      providers: [provider],
      allowedProviderIds: ["trusted-eu"],
      timeoutMs: 100
    })
    for (const request of [
      new Request("https://example.test/v1/identity-verifications", { method: "GET" }),
      new Request("https://example.test/other", { method: "POST", body: "{}" })
    ]) {
      const response = await service.handler(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ code: "not_found" })
    }
    const invalidBodies = ["[]", JSON.stringify({ requestId: "request-1" })]
    for (const body of invalidBodies) {
      const response = await service.handler(
        new Request("https://example.test/v1/identity-verifications", {
          method: "POST",
          body
        })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "identity_verification_rejected" })
    }
    const malformed = await service.handler(
      new Request("https://example.test/v1/identity-verifications", {
        method: "POST",
        body: "{"
      })
    )
    expect(malformed.status).toBe(503)
    expect(provider.calls()).toBe(0)
  })

  test("maps typed, conflict, and opaque failures from the public handler", async () => {
    const command = {
      requestId: "request-failure",
      applicantReference: "applicant-1",
      providerId: "trusted-eu",
      documentDigest: verifiedDigest
    }
    const failures: readonly [unknown, number][] = [
      [new TypeError("invalid requestId"), 400],
      [new RangeError("invalid digest"), 400],
      [new Error("identity request conflict"), 409],
      [new Error("provider unavailable"), 503],
      ["opaque failure", 503]
    ]
    for (const [failure, status] of failures) {
      const response = await newIdentityVerificationHandler(async () => {
        throw failure
      })(
        new Request("https://example.test/v1/identity-verifications", {
          method: "POST",
          body: JSON.stringify(command)
        })
      )
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({
        code: "identity_verification_rejected"
      })
    }
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

  test("validates command and provider construction boundaries", () => {
    expect(() =>
      validateIdentityCommand({
        requestId: "bad/id",
        applicantReference: "applicant-1",
        providerId: "trusted-eu",
        documentDigest: verifiedDigest
      })
    ).toThrow("invalid requestId")
    expect(() =>
      validateIdentityCommand({
        requestId: "request-1",
        applicantReference: "bad applicant",
        providerId: "trusted-eu",
        documentDigest: verifiedDigest
      })
    ).toThrow("invalid applicantReference")
    expect(() =>
      validateIdentityCommand({
        requestId: "request-1",
        applicantReference: "applicant-1",
        providerId: "trusted/eu",
        documentDigest: verifiedDigest
      })
    ).toThrow("invalid providerId")
    expect(() =>
      validateIdentityCommand({
        requestId: "request-1",
        applicantReference: "applicant-1",
        providerId: "trusted-eu",
        documentDigest: "A".repeat(64)
      })
    ).toThrow("lowercase SHA-256")
    expect(() =>
      newMemoryIdentityProvider({
        providerId: "trusted-eu",
        decisionsByDigest: {},
        latencyMs: -1
      })
    ).toThrow("latencyMs")
    expect(() =>
      newMemoryIdentityProvider({
        providerId: "trusted-eu",
        decisionsByDigest: { invalid: "review" }
      })
    ).toThrow("invalid provider digest")
    expect(() =>
      newMemoryIdentityProvider({
        providerId: "trusted-eu",
        decisionsByDigest: { [verifiedDigest]: "unknown" as never }
      })
    ).toThrow("invalid provider decision")
    expect(() =>
      newMemoryIdentityProvider({
        providerId: "trusted-eu",
        decisionsByDigest: {},
        available: "yes" as never
      })
    ).toThrow("available must be boolean")
  })

  test("rejects invalid gateway configuration and allowlist duplication", () => {
    const provider = newMemoryIdentityProvider({ providerId: "trusted-eu", decisionsByDigest: {} })
    for (const options of [
      { providers: [provider], allowedProviderIds: ["trusted-eu"], timeoutMs: 0 },
      {
        providers: [provider],
        allowedProviderIds: ["trusted-eu"],
        timeoutMs: 100,
        failureThreshold: 0
      },
      { providers: [provider, provider], allowedProviderIds: ["trusted-eu"], timeoutMs: 100 },
      { providers: [provider], allowedProviderIds: [], timeoutMs: 100 },
      { providers: [provider], allowedProviderIds: ["trusted-eu", "trusted-eu"], timeoutMs: 100 },
      { providers: [provider], allowedProviderIds: ["missing"], timeoutMs: 100 }
    ]) {
      expect(() => newResilientIdentityProviderGateway(options)).toThrow()
    }
  })

  test("completes provider latency waits and cleans their Context listeners", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "delayed",
      decisionsByDigest: { [verifiedDigest]: "rejected" },
      latencyMs: 1
    })
    await expect(
      provider.verify(background(), {
        requestId: "request-delayed",
        applicantReference: "applicant-1",
        providerId: "delayed",
        documentDigest: verifiedDigest
      })
    ).resolves.toBe("rejected")
    expect(provider.calls()).toBe(1)
  })

  test("rejects an already-aborted provider Context without starting its timer", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "aborted",
      decisionsByDigest: {},
      latencyMs: 10
    })
    const controller = new AbortController()
    controller.abort()
    const base = background()
    const canceledContext = Object.freeze({
      deadline: base.deadline.bind(base),
      done: () => controller.signal,
      err: () => null,
      value: base.value.bind(base)
    })
    await expect(
      provider.verify(canceledContext, {
        requestId: "request-aborted",
        applicantReference: "applicant-1",
        providerId: "aborted",
        documentDigest: verifiedDigest
      })
    ).rejects.toThrow("context canceled")
  })

  test("keeps repository save idempotent and rejects direct fingerprint conflicts", () => {
    const repository = newMemoryIdentityVerificationRepository()
    const command = {
      requestId: "repository-request",
      applicantReference: "applicant-1",
      providerId: "trusted-eu",
      documentDigest: verifiedDigest
    }
    const verification = {
      requestId: command.requestId,
      applicantReference: command.applicantReference,
      providerId: command.providerId,
      decision: "verified" as const
    }
    expect(repository.get(background(), command.requestId)).toBeNull()
    expect(repository.save(background(), command, verification)).toBe(verification)
    expect(repository.save(background(), command, verification)).toBe(verification)
    expect(() =>
      repository.save(background(), { ...command, documentDigest: reviewDigest }, verification)
    ).toThrow("identity request conflict")
  })

  test("rejects canceled provider calls with the caller's exact Context outcome", async () => {
    const provider = newMemoryIdentityProvider({
      providerId: "slow",
      decisionsByDigest: {},
      latencyMs: 100
    })
    const gateway = newResilientIdentityProviderGateway({
      providers: [provider],
      allowedProviderIds: ["slow"],
      timeoutMs: 1_000
    })
    const [ctx, cancel] = withCancel(background())
    const pending = gateway.verify(ctx, {
      requestId: "request-canceled",
      applicantReference: "applicant-1",
      providerId: "slow",
      documentDigest: verifiedDigest
    })
    cancel()
    await expect(pending).rejects.toThrow("context canceled")
  })

  test("rejects terminal health checks and exposes live and ready status", async () => {
    const provider = newMemoryIdentityProvider({ providerId: "ready", decisionsByDigest: {} })
    const service = newDigitalIdentityService({
      providers: [provider],
      allowedProviderIds: ["ready"],
      timeoutMs: 100
    })
    expect((await service.health(new Request("https://example.test/livez"))).status).toBe(200)
    expect((await service.health(new Request("https://example.test/readyz"))).status).toBe(200)
    const canceled = withCancel(background())
    canceled[1]()
    const report = await service.probes.check(canceled[0], "live")
    expect(report.ok).toBeFalse()
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
