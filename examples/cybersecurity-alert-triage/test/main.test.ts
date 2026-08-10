import { newConfig, objectSource, source, type ConfigObject } from "@go-like/config"
import { background, withCancelCause } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import {
  isAlertIdConflict,
  newEtcdAlertTriageLedger,
  newEtcdTriageConfig,
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
  return persistedPayload(
    `security-alerts/${decision.alertId}`,
    JSON.stringify({
      version: 1,
      operation: "seed",
      value: btoa(JSON.stringify(decision)),
      metadata: { severity: decision.severity, queue: decision.queue },
      expiresAt: null
    })
  )
}

/** Returns one exact etcd range response for a supplied provider payload. */
function persistedPayload(key: string, payload: string, revision = "7"): Response {
  return Response.json({
    header: { revision },
    kvs: [{ key: btoa(key), value: btoa(payload), mod_revision: revision, lease: "0" }]
  })
}

/** Decodes the ASCII JSON carrier used by the etcd JSON gateway. */
function decodeBase64(value: string): string {
  return atob(value)
}

interface FakeEtcdRow {
  readonly key: string
  payload: string
  revision: string
}

interface FakeTriageEtcd {
  fetch: (request: Request) => Promise<Response>
  row: FakeEtcdRow | null
  dropAfterFirstRange: boolean
  rewriteAfterWrite: "none" | "different-alert" | "missing"
  rangeCalls: number
}

/** Creates a small stateful etcd JSON-gateway fake for the public ledger adapter. */
function installFetch(fetch: (request: Request) => Promise<Response>): typeof globalThis.fetch {
  const captured = fetch as typeof globalThis.fetch
  captured.preconnect = function preconnect(): void {}
  return captured
}

function fakeTriageEtcd(initial: FakeEtcdRow | null = null): FakeTriageEtcd {
  const fake: FakeTriageEtcd = {
    fetch: undefined as unknown as (request: Request) => Promise<Response>,
    row: initial,
    dropAfterFirstRange: false,
    rewriteAfterWrite: "none",
    rangeCalls: 0
  }
  let revision = Number(initial?.revision ?? "1")
  fake.fetch = async function fetchTriageEtcd(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/v3/watch") {
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true
        })
      })
    }
    const body = (await request.json()) as Record<string, unknown>
    if (path === "/v3/kv/range") {
      fake.rangeCalls += 1
      const row = fake.row
      if (fake.dropAfterFirstRange && fake.rangeCalls > 1) {
        fake.row = null
      }
      return Response.json({
        header: { revision: String(revision) },
        ...(row === null || (fake.dropAfterFirstRange && fake.rangeCalls > 1)
          ? {}
          : {
              kvs: [
                {
                  key: btoa(row.key),
                  value: btoa(row.payload),
                  create_revision: row.revision,
                  mod_revision: row.revision,
                  version: "1",
                  lease: "0"
                }
              ]
            })
      })
    }
    if (path === "/v3/kv/txn") {
      const compare = (body.compare as readonly Record<string, unknown>[])[0]
      const success = compare?.target === "VERSION" && fake.row === null
      if (!success) {
        const row = fake.row
        return Response.json({
          header: { revision: String(revision) },
          responses: [
            {
              response_range: {
                header: { revision: String(revision) },
                ...(row === null
                  ? {}
                  : {
                      kvs: [
                        {
                          key: btoa(row.key),
                          value: btoa(row.payload),
                          create_revision: row.revision,
                          mod_revision: row.revision,
                          version: "1",
                          lease: "0"
                        }
                      ]
                    })
              }
            }
          ]
        })
      }
      const requestPut = body.success as readonly Record<string, unknown>[]
      const put = requestPut[0]?.request_put as Record<string, unknown>
      revision += 1
      const key = decodeBase64(String(put.key))
      fake.row = { key, payload: decodeBase64(String(put.value)), revision: String(revision) }
      if (fake.rewriteAfterWrite === "different-alert") {
        const stored = JSON.parse(fake.row.payload) as Record<string, unknown>
        const decision = JSON.parse(decodeBase64(String(stored.value))) as TriageDecision
        stored.value = btoa(JSON.stringify({ ...decision, alertId: "different-alert" }))
        fake.row.payload = JSON.stringify(stored)
      } else if (fake.rewriteAfterWrite === "missing") {
        fake.row = null
      }
      return Response.json({
        header: { revision: String(revision) },
        succeeded: true,
        responses: [{ response_put: { header: { revision: String(revision) } } }]
      })
    }
    throw new Error(`unexpected etcd path ${path}`)
  }
  return fake
}

/** Builds one persisted Store payload around an inner decision and optional metadata. */
function rawStoredPayload(
  value: string,
  metadata: { readonly severity: string; readonly queue: string }
): string {
  return JSON.stringify({
    version: 1,
    operation: "seed",
    value: btoa(value),
    metadata,
    expiresAt: null
  })
}

/** Builds one valid persisted Store payload around a decision and optional metadata. */
function storedPayload(
  decision: TriageDecision,
  metadata: { readonly severity: string; readonly queue: string } = {
    severity: decision.severity,
    queue: decision.queue
  }
): string {
  return rawStoredPayload(JSON.stringify(decision), metadata)
}

/** Builds one valid fake etcd row for a previously persisted decision. */
function storedRow(
  decision: TriageDecision,
  metadata: { readonly severity: string; readonly queue: string } = {
    severity: decision.severity,
    queue: decision.queue
  }
): FakeEtcdRow {
  return {
    key: `security-alerts/${decision.alertId}`,
    payload: storedPayload(decision, metadata),
    revision: "7"
  }
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
    expect(
      triageSecurityAlert(
        {
          alertId: "alert-low",
          source: "network",
          failedAttempts: 0,
          malwareConfidence: 0,
          privileged: false
        },
        rules
      )
    ).toMatchObject({ severity: "low", queue: "review" })
    expect(
      triageSecurityAlert(
        {
          alertId: "alert-medium",
          source: "network",
          failedAttempts: 1,
          malwareConfidence: 0,
          privileged: false
        },
        rules
      )
    ).toMatchObject({ severity: "medium", queue: "review" })
  })

  test("rejects invalid rules and alerts before classification", () => {
    for (const invalid of [
      { ...rules, highFailedAttempts: 0 },
      { ...rules, highFailedAttempts: 10 },
      { ...rules, highMalwareConfidence: -1 },
      { ...rules, criticalMalwareConfidence: 101 },
      { ...rules, highMalwareConfidence: 90 }
    ]) {
      expect(() =>
        triageSecurityAlert(
          {
            alertId: "alert-invalid-rules",
            source: "network",
            failedAttempts: 0,
            malwareConfidence: 0,
            privileged: false
          },
          invalid
        )
      ).toThrow()
    }
    expect(() =>
      triageSecurityAlert(
        {
          alertId: "bad/id",
          source: "network",
          failedAttempts: 0,
          malwareConfidence: 0,
          privileged: false
        },
        rules
      )
    ).toThrow("invalid alertId")
    expect(() =>
      triageSecurityAlert(
        {
          alertId: "alert-invalid-source",
          source: "other" as SecurityAlert["source"],
          failedAttempts: 0,
          malwareConfidence: 0,
          privileged: false
        },
        rules
      )
    ).toThrow("unsupported alert source")
    expect(() =>
      triageSecurityAlert(
        {
          alertId: "alert-invalid-attempts",
          source: "network",
          failedAttempts: -1,
          malwareConfidence: 0,
          privileged: false
        },
        rules
      )
    ).toThrow("failedAttempts must be a non-negative safe count")
    expect(() =>
      triageSecurityAlert(
        {
          alertId: "alert-invalid-confidence",
          source: "network",
          failedAttempts: 0,
          malwareConfidence: 101,
          privileged: false
        },
        rules
      )
    ).toThrow("malwareConfidence must be between 0 and 100")
    expect(() =>
      triageSecurityAlert(
        {
          alertId: "alert-invalid-privileged",
          source: "network",
          failedAttempts: 0,
          malwareConfidence: 0,
          privileged: "no" as unknown as boolean
        },
        rules
      )
    ).toThrow("privileged must be a boolean")
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

  test("rejects invalid public HTTP routes and alert shapes", async () => {
    const handler = newSecurityTriageHandler(async () => {
      throw new Error("triage must not run")
    })
    for (const request of [
      new Request("https://example.test/v1/security/alerts/triage", { method: "GET" }),
      new Request("https://example.test/other", { method: "POST", body: "{}" })
    ]) {
      const response = await handler(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ code: "not_found" })
    }
    for (const body of [
      "[]",
      JSON.stringify({
        alertId: 1,
        source: "network",
        failedAttempts: 0,
        malwareConfidence: 0,
        privileged: false
      })
    ]) {
      const response = await handler(
        new Request("https://example.test/v1/security/alerts/triage", {
          method: "POST",
          body
        })
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: "invalid_security_alert" })
    }
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

  test("rejects malformed current Config rules after readiness admits the request", async () => {
    for (const triageRules of [[], { highFailedAttempts: 5, criticalFailedAttempts: 10 }]) {
      const config = newConfig(
        source(objectSource("invalid-triage", { triage: triageRules } as ConfigObject))
      )
      const triage = newTriageAlert(
        config,
        newTriageReadiness(config),
        newMemoryAlertTriageLedger()
      )
      await config.load(background())
      try {
        await expect(
          triage(background(), {
            alertId: "alert-invalid-config",
            source: "network",
            failedAttempts: 0,
            malwareConfidence: 0,
            privileged: false
          })
        ).rejects.toThrow("triage rules are invalid")
      } finally {
        await config.close(background())
      }
    }
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
        globalThis.fetch = installFetch(storedFetch)
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

  test("persists and replays decisions through the real etcd ledger boundary", async () => {
    const decision = triageSecurityAlert(
      {
        alertId: "etcd-first",
        source: "identity",
        failedAttempts: 6,
        malwareConfidence: 0,
        privileged: false
      },
      rules
    )
    const fake = fakeTriageEtcd()
    const originalFetch = globalThis.fetch
    globalThis.fetch = installFetch(fake.fetch)
    try {
      const ledger = newEtcdAlertTriageLedger({
        address: "http://etcd.test",
        configKey: "unused"
      })
      await expect(ledger.record(background(), decision)).resolves.toEqual(decision)
      await expect(ledger.record(background(), decision)).resolves.toEqual(decision)
      expect(fake.row?.key).toBe("security-alerts/etcd-first")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects malformed persisted decisions before trusting their fields", async () => {
    const decision = triageSecurityAlert(
      {
        alertId: "malformed-stored",
        source: "network",
        failedAttempts: 0,
        malwareConfidence: 0,
        privileged: false
      },
      rules
    )
    const originalFetch = globalThis.fetch
    const invalidPayloads = [
      "",
      "not-json",
      JSON.stringify([]),
      JSON.stringify({ alertId: decision.alertId }),
      JSON.stringify({ ...decision, source: "unknown" }),
      JSON.stringify({ ...decision, failedAttempts: -1 }),
      JSON.stringify({ ...decision, privileged: "yes" }),
      JSON.stringify({ ...decision, severity: "critical", queue: "review" }),
      JSON.stringify({
        ...decision,
        severity: "high",
        queue: "investigation",
        malwareConfidence: 100
      }),
      JSON.stringify({ ...decision, severity: "low", queue: "review", failedAttempts: 1 }),
      JSON.stringify({ ...decision, severity: "medium", queue: "review" }),
      JSON.stringify({
        ...decision,
        severity: "critical",
        queue: "immediate-response",
        failedAttempts: 1
      })
    ]
    try {
      for (const [index, inner] of invalidPayloads.entries()) {
        const fake = fakeTriageEtcd({
          key: `security-alerts/malformed-stored-${index}`,
          payload: rawStoredPayload(inner, {
            severity: decision.severity,
            queue: decision.queue
          }),
          revision: "7"
        })
        globalThis.fetch = installFetch(fake.fetch)
        await expect(
          newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" }).record(
            background(),
            { ...decision, alertId: `malformed-stored-${index}` }
          )
        ).rejects.toThrow("stored etcd alert decision is invalid")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("maps etcd conflicts, metadata corruption, and readback failures safely", async () => {
    const decision = triageSecurityAlert(
      {
        alertId: "etcd-existing",
        source: "network",
        failedAttempts: 0,
        malwareConfidence: 0,
        privileged: false
      },
      rules
    )
    const originalFetch = globalThis.fetch
    try {
      const conflictFake = fakeTriageEtcd(storedRow(decision))
      globalThis.fetch = installFetch(conflictFake.fetch)
      const ledger = newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" })
      await expect(ledger.record(background(), decision)).resolves.toEqual(decision)
      await expect(
        ledger.record(
          background(),
          triageSecurityAlert(
            {
              alertId: decision.alertId,
              source: decision.source,
              failedAttempts: 1,
              malwareConfidence: decision.malwareConfidence,
              privileged: decision.privileged
            },
            rules
          )
        )
      ).rejects.toThrow()

      const metadataFake = fakeTriageEtcd(
        storedRow(decision, { severity: "high", queue: "investigation" })
      )
      globalThis.fetch = installFetch(metadataFake.fetch)
      await expect(
        newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" }).record(
          background(),
          decision
        )
      ).rejects.toThrow("stored etcd alert decision is invalid")

      const missingConflictFake = fakeTriageEtcd(storedRow(decision))
      missingConflictFake.dropAfterFirstRange = true
      globalThis.fetch = installFetch(missingConflictFake.fetch)
      await expect(
        newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" }).record(
          background(),
          decision
        )
      ).rejects.toThrow("etcd alert decision conflict readback failed")

      const rewriteFake = fakeTriageEtcd()
      rewriteFake.rewriteAfterWrite = "different-alert"
      globalThis.fetch = installFetch(rewriteFake.fetch)
      await expect(
        newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" }).record(
          background(),
          decision
        )
      ).rejects.toThrow("etcd alert decision readback failed")

      const missingReadbackFake = fakeTriageEtcd()
      missingReadbackFake.rewriteAfterWrite = "missing"
      globalThis.fetch = installFetch(missingReadbackFake.fetch)
      await expect(
        newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" }).record(
          background(),
          decision
        )
      ).rejects.toThrow("etcd alert decision readback failed")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("keeps alert conflict classification narrow and preserves terminal Context failures", async () => {
    expect(isAlertIdConflict(new Error("ordinary"))).toBeFalse()
    expect(isAlertIdConflict(null)).toBeFalse()
    const conflict = Object.assign(new Error("conflict"), { code: "ALERT_ID_CONFLICT" })
    expect(isAlertIdConflict(conflict)).toBeTrue()
    const throwingError = new Proxy(new Error("proxy"), {
      has(_target, key) {
        if (key === "code") throw new Error("inspection failed")
        return false
      }
    })
    expect(isAlertIdConflict(throwingError)).toBeFalse()

    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("terminal")
    cancel(failure)
    const ledger = newEtcdAlertTriageLedger({ address: "http://etcd.test", configKey: "unused" })
    const originalFetch = globalThis.fetch
    const fetchTerminal = async function fetchTerminal(): Promise<Response> {
      return Response.json({})
    }
    fetchTerminal.preconnect = function preconnect(): void {}
    globalThis.fetch = installFetch(fetchTerminal)
    try {
      await expect(
        ledger.record(
          ctx,
          triageSecurityAlert(
            {
              alertId: "terminal-alert",
              source: "network",
              failedAttempts: 0,
              malwareConfidence: 0,
              privileged: false
            },
            rules
          )
        )
      ).rejects.toBe(failure)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not classify an opaque store failure as an alert conflict", async () => {
    const originalFetch = globalThis.fetch
    const originalRandomUuid = crypto.randomUUID
    const failure = new Error("opaque store failure")
    Object.defineProperty(failure, "code", {
      get() {
        throw new Error("opaque failure inspection")
      }
    })
    const fetchOpaque = async function fetchOpaque(): Promise<Response> {
      return Response.json({ header: { revision: "1" } })
    }
    fetchOpaque.preconnect = function preconnect(): void {}
    globalThis.fetch = installFetch(fetchOpaque)
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        throw failure
      }
    })
    try {
      await expect(
        newEtcdAlertTriageLedger({
          address: "http://etcd.test",
          configKey: "unused"
        }).record(
          background(),
          triageSecurityAlert(
            {
              alertId: "opaque-store-failure",
              source: "network",
              failedAttempts: 0,
              malwareConfidence: 0,
              privileged: false
            },
            rules
          )
        )
      ).rejects.toBe(failure)
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUuid
      })
    }
  })

  test("loads etcd rules through the Config provider and closes its watcher", async () => {
    const originalFetch = globalThis.fetch
    const fetchRules = async function fetchRules(request: Request): Promise<Response> {
      if (new URL(request.url).pathname === "/v3/watch") {
        return await new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true
          })
        })
      }
      return persistedPayload("security/config", JSON.stringify({ triage: rules }), "12")
    }
    fetchRules.preconnect = function preconnect(): void {}
    globalThis.fetch = installFetch(fetchRules)
    const config = newEtcdTriageConfig({
      address: "http://etcd.test",
      configKey: "security/config"
    })
    try {
      await config.load(background())
      expect(config.value("triage").load()).toEqual(rules)
    } finally {
      await config.close(background())
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
