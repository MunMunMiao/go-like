import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"

import { newTriageConfig, newTriageReadiness, newMemoryAlertTriageLedger } from "../src/config"
import { newSecurityTriageHandler } from "../src/http"
import { newTriageAlert, triageSecurityAlert } from "../src/service"

const rules = Object.freeze({
  highFailedAttempts: 5,
  criticalFailedAttempts: 10,
  highMalwareConfidence: 60,
  criticalMalwareConfidence: 90
})

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
    } finally {
      await config.close(background())
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
})
