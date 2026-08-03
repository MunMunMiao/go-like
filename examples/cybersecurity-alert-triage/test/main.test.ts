import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"

import {
  newEtcdAlertTriageLedger,
  newMemoryAlertTriageLedger,
  newTriageConfig,
  newTriageReadiness
} from "../src/config"
import { newSecurityTriageHandler } from "../src/http"
import {
  newTriageAlert,
  triageSecurityAlert,
  type SecurityAlert,
  type TriageDecision
} from "../src/service"

const rules = Object.freeze({
  highFailedAttempts: 5,
  criticalFailedAttempts: 10,
  highMalwareConfidence: 60,
  criticalMalwareConfidence: 90
})

/** Returns one exact etcd range response containing a seeded Store decision. */
function persistedDecision(decision: TriageDecision): Response {
  const key = `security-alerts/${decision.alertId}`
  const payload = JSON.stringify({
    version: 1,
    operation: "seed",
    value: btoa(JSON.stringify(decision)),
    metadata: { severity: decision.severity, queue: decision.queue },
    expiresAt: null
  })
  return Response.json({
    header: { revision: "7" },
    kvs: [{ key: btoa(key), value: btoa(payload), mod_revision: "7", lease: "0" }]
  })
}

describe("cybersecurity alert triage", () => {
  test("uses inclusive high and critical boundaries", () => {
    expect(
      triageSecurityAlert(
        {
          alertId: "alert-high",
          source: "identity",
          failedAttempts: 5,
          malwareConfidence: 0,
          privileged: false
        },
        rules
      ).severity
    ).toBe("high")
    expect(
      triageSecurityAlert(
        {
          alertId: "alert-critical",
          source: "endpoint",
          failedAttempts: 0,
          malwareConfidence: 90,
          privileged: false
        },
        rules
      ).severity
    ).toBe("critical")
  })

  test("never downgrades privileged activity or a stronger signal", () => {
    expect(
      triageSecurityAlert(
        {
          alertId: "alert-privileged",
          source: "identity",
          failedAttempts: 0,
          malwareConfidence: 0,
          privileged: true
        },
        rules
      ).queue
    ).toBe("immediate-response")
    expect(
      triageSecurityAlert(
        {
          alertId: "alert-strong",
          source: "endpoint",
          failedAttempts: 1,
          malwareConfidence: 95,
          privileged: false
        },
        rules
      ).severity
    ).toBe("critical")
  })

  test("fails readiness before Config publishes and does not record", async () => {
    const config = newTriageConfig(rules)
    const triage = newTriageAlert(config, newTriageReadiness(config), newMemoryAlertTriageLedger())
    await expect(
      triage(background(), {
        alertId: "alert-not-ready",
        source: "network",
        failedAttempts: 1,
        malwareConfidence: 0,
        privileged: false
      })
    ).rejects.toThrow("triage service is not ready")
  })

  test("keeps exact alert replay stable and rejects conflicting facts", async () => {
    const config = newTriageConfig(rules)
    const triage = newTriageAlert(config, newTriageReadiness(config), newMemoryAlertTriageLedger())
    await config.load(background())
    const alert = Object.freeze({
      alertId: "alert-stable",
      source: "network",
      failedAttempts: 6,
      malwareConfidence: 10,
      privileged: false
    })
    try {
      const first = await triage(background(), alert)
      expect(await triage(background(), alert)).toEqual(first)
      await expect(
        triage(background(), {
          alertId: "alert-stable",
          source: "network",
          failedAttempts: 7,
          malwareConfidence: 10,
          privileged: false
        })
      ).rejects.toThrow("alertId already used by different alert facts")
      const conflict = await newSecurityTriageHandler(triage)(
        new Request("https://example.test/v1/security/alerts/triage", {
          method: "POST",
          body: JSON.stringify({
            ...alert,
            failedAttempts: 7
          })
        })
      )
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toEqual({
        code: "security_triage_rejected"
      })
    } finally {
      await config.close(background())
    }
  })

  test("fails closed on persisted decisions that no valid rule set can produce", async () => {
    const invalid: readonly TriageDecision[] = [
      {
        alertId: "persisted-privileged-low",
        source: "identity",
        failedAttempts: 0,
        malwareConfidence: 0,
        privileged: true,
        severity: "low",
        queue: "review"
      },
      {
        alertId: "persisted-confidence-high",
        source: "endpoint",
        failedAttempts: 0,
        malwareConfidence: 100,
        privileged: false,
        severity: "high",
        queue: "investigation"
      },
      {
        alertId: "persisted-signaled-low",
        source: "network",
        failedAttempts: 1,
        malwareConfidence: 0,
        privileged: false,
        severity: "low",
        queue: "review"
      },
      {
        alertId: "persisted-empty-medium",
        source: "network",
        failedAttempts: 0,
        malwareConfidence: 0,
        privileged: false,
        severity: "medium",
        queue: "review"
      },
      {
        alertId: "persisted-empty-critical",
        source: "network",
        failedAttempts: 0,
        malwareConfidence: 0,
        privileged: false,
        severity: "critical",
        queue: "immediate-response"
      },
      {
        alertId: "persisted-impossible-critical",
        source: "identity",
        failedAttempts: 1,
        malwareConfidence: 0,
        privileged: false,
        severity: "critical",
        queue: "immediate-response"
      }
    ]
    const originalFetch = globalThis.fetch
    try {
      for (const stored of invalid) {
        const storedFetch = async function fetchStoredDecision(): Promise<Response> {
          return persistedDecision(stored)
        }
        storedFetch.preconnect = function preconnect(): void {}
        globalThis.fetch = storedFetch
        const alert: SecurityAlert = {
          alertId: stored.alertId,
          source: stored.source,
          failedAttempts: stored.failedAttempts,
          malwareConfidence: stored.malwareConfidence,
          privileged: stored.privileged
        }
        await expect(
          newEtcdAlertTriageLedger({
            address: "http://etcd.test",
            configKey: "unused"
          }).record(background(), triageSecurityAlert(alert, rules))
        ).rejects.toThrow("stored etcd alert decision is invalid")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("serves decisions from an immutable Config value", async () => {
    const mutableRules = {
      highFailedAttempts: 5,
      criticalFailedAttempts: 10,
      highMalwareConfidence: 60,
      criticalMalwareConfidence: 90
    }
    const config = newTriageConfig(mutableRules)
    const handler = newSecurityTriageHandler(
      newTriageAlert(config, newTriageReadiness(config), newMemoryAlertTriageLedger())
    )
    await config.load(background())
    mutableRules.criticalFailedAttempts = 999
    try {
      const response = await handler(
        new Request("https://example.test/v1/security/alerts/triage", {
          method: "POST",
          body: JSON.stringify({
            alertId: "alert-http",
            source: "identity",
            failedAttempts: 10,
            malwareConfidence: 0,
            privileged: false
          })
        })
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        alertId: "alert-http",
        severity: "critical",
        queue: "immediate-response"
      })
    } finally {
      await config.close(background())
    }
  })

  test("does not expose or classify operational failures by their message text", async () => {
    const handler = newSecurityTriageHandler(async () => {
      throw new Error("different alert upstream included token=secret")
    })

    const response = await handler(
      new Request("https://example.test/v1/security/alerts/triage", {
        method: "POST",
        body: JSON.stringify({
          alertId: "alert-operational-failure",
          source: "network",
          failedAttempts: 1,
          malwareConfidence: 0,
          privileged: false
        })
      })
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "security_triage_rejected" })
  })

  test("separates invalid request bodies from internal typed failures", async () => {
    const malformed = await newSecurityTriageHandler(async () => {
      throw new Error("triage must not run")
    })(
      new Request("https://example.test/v1/security/alerts/triage", {
        method: "POST",
        body: "{"
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ code: "invalid_security_alert" })

    for (const failure of [
      new TypeError("dependency contract failed"),
      new RangeError("overflow")
    ]) {
      const response = await newSecurityTriageHandler(async () => {
        throw failure
      })(
        new Request("https://example.test/v1/security/alerts/triage", {
          method: "POST",
          body: JSON.stringify({
            alertId: "alert-internal-failure",
            source: "network",
            failedAttempts: 1,
            malwareConfidence: 0,
            privileged: false
          })
        })
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        code: "security_triage_rejected"
      })
    }
  })
})
