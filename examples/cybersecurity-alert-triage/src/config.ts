import { newConfig, source, objectSource, type Config, type ConfigObject } from "@go-like/config"
import { etcdSource } from "@go-like/config-etcd"
import type { Context } from "@go-like/context"
import { newProbeRegistry, type ProbeRegistry } from "@go-like/health"
import { ifAbsent, type Store, type StoreRecord } from "@go-like/store"
import { newEtcdStore } from "@go-like/store-etcd"

import {
  validateSecurityAlert,
  validateTriageRules,
  type TriageDecision,
  type TriageRules
} from "./service"

export interface AlertTriageLedger {
  record(ctx: Context, decision: TriageDecision): Promise<TriageDecision>
}

export interface TriageEtcdOptions {
  readonly address: string
  readonly configKey: string
}

const DecisionDecoder = new TextDecoder("utf-8", { fatal: true })

/** Compares all alert facts that are bound to one immutable alert identity. */
function sameAlert(left: TriageDecision, right: TriageDecision): boolean {
  return (
    left.alertId === right.alertId &&
    left.source === right.source &&
    left.failedAttempts === right.failedAttempts &&
    left.malwareConfidence === right.malwareConfidence &&
    left.privileged === right.privileged
  )
}

/** Compares the immutable decision fields written by the authoritative first caller. */
function sameDecision(left: TriageDecision, right: TriageDecision): boolean {
  return sameAlert(left, right) && left.severity === right.severity && left.queue === right.queue
}

/** Decodes one bounded, persisted decision without trusting provider-owned bytes. */
function storedDecision(bytes: Uint8Array): TriageDecision {
  let value: unknown
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > 4_096) throw new Error("invalid size")
    value = JSON.parse(DecisionDecoder.decode(bytes))
  } catch {
    throw new Error("stored etcd alert decision is invalid")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored etcd alert decision is invalid")
  }
  const alertId = Reflect.get(value, "alertId")
  const source = Reflect.get(value, "source")
  const failedAttempts = Reflect.get(value, "failedAttempts")
  const malwareConfidence = Reflect.get(value, "malwareConfidence")
  const privileged = Reflect.get(value, "privileged")
  const severity = Reflect.get(value, "severity")
  const queue = Reflect.get(value, "queue")
  if (
    typeof alertId !== "string" ||
    (source !== "endpoint" && source !== "identity" && source !== "network") ||
    typeof failedAttempts !== "number" ||
    typeof malwareConfidence !== "number" ||
    typeof privileged !== "boolean" ||
    (severity !== "critical" &&
      severity !== "high" &&
      severity !== "low" &&
      severity !== "medium") ||
    (queue !== "immediate-response" && queue !== "investigation" && queue !== "review") ||
    (severity === "critical"
      ? queue !== "immediate-response"
      : severity === "high"
        ? queue !== "investigation"
        : queue !== "review")
  ) {
    throw new Error("stored etcd alert decision is invalid")
  }
  const alert = Object.freeze({
    alertId,
    source,
    failedAttempts,
    malwareConfidence,
    privileged
  })
  try {
    validateSecurityAlert(alert)
  } catch {
    throw new Error("stored etcd alert decision is invalid")
  }
  const hasNumericSignal = failedAttempts > 0 || malwareConfidence > 0
  if (
    (severity !== "critical" && (privileged || malwareConfidence === 100)) ||
    (severity === "low" && hasNumericSignal) ||
    (severity === "medium" && !hasNumericSignal) ||
    (severity === "critical" && !privileged && failedAttempts < 2 && malwareConfidence === 0)
  ) {
    throw new Error("stored etcd alert decision is invalid")
  }
  return Object.freeze({ ...alert, severity, queue })
}

/** Recognizes only the absence conflict produced by an ifAbsent Store write. */
function isStoreAbsenceConflict(value: unknown): boolean {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      Reflect.get(value, "code") === "GO_LIKE_STORE_CONFLICT" &&
      Reflect.get(value, "expectedRevision") === null
    )
  } catch {
    return false
  }
}

/** Creates one stable business conflict without exposing ledger diagnostics. */
function alertIdConflict(): Error & { readonly code: "ALERT_ID_CONFLICT" } {
  return Object.assign(new Error("alertId already used by different alert facts"), {
    code: "ALERT_ID_CONFLICT" as const
  })
}

/** Reports whether one failure is the alert identity conflict owned by this ledger. */
export function isAlertIdConflict(value: unknown): boolean {
  try {
    if (!(value instanceof Error)) return false
    return "code" in value && value.code === "ALERT_ID_CONFLICT"
  } catch {
    return false
  }
}

/** Creates the immutable SOC rule source and go-like Config lifecycle. */
export function newTriageConfig(rules: TriageRules): Config<ConfigObject> {
  validateTriageRules(rules)
  return newConfig(
    source(
      objectSource(
        "fixed-soc-triage-rules",
        Object.freeze({
          triage: Object.freeze({
            highFailedAttempts: rules.highFailedAttempts,
            criticalFailedAttempts: rules.criticalFailedAttempts,
            highMalwareConfidence: rules.highMalwareConfidence,
            criticalMalwareConfidence: rules.criticalMalwareConfidence
          })
        })
      )
    )
  )
}

/** Creates a Config that loads and watches the complete SOC rule document in real etcd. */
export function newEtcdTriageConfig(options: TriageEtcdOptions): Config<ConfigObject> {
  return newConfig(
    source(
      etcdSource({
        fetch(request) {
          return fetch(request)
        },
        address: options.address,
        key: options.configKey
      })
    )
  )
}

/** Creates a readiness registry that fails closed until Config has published rules. */
export function newTriageReadiness(config: Config<ConfigObject>): ProbeRegistry {
  const readiness = newProbeRegistry()
  readiness.register("ready", "triage.rules", () => {
    if (config.value("triage").load() === null) throw new Error("triage rules are not ready")
  })
  return readiness
}

/** Creates an in-memory alert ledger with idempotent replay and conflict rejection. */
export function newMemoryAlertTriageLedger(): AlertTriageLedger {
  const decisions = new Map<string, TriageDecision>()
  return Object.freeze({
    async record(ctx: Context, decision: TriageDecision): Promise<TriageDecision> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = decisions.get(decision.alertId)
      if (current !== undefined) {
        if (!sameAlert(current, decision)) {
          throw alertIdConflict()
        }
        return current
      }
      decisions.set(decision.alertId, decision)
      return decision
    }
  })
}

/** Atomically admits immutable alert decisions into real etcd Store records. */
export function newEtcdAlertTriageLedger(options: TriageEtcdOptions): AlertTriageLedger {
  const store: Store = newEtcdStore({
    fetch(request) {
      return fetch(request)
    },
    address: options.address
  })
  const encoder = new TextEncoder()
  return Object.freeze({
    async record(ctx: Context, decision: TriageDecision): Promise<TriageDecision> {
      const key = `security-alerts/${decision.alertId}`
      let written: StoreRecord
      try {
        written = await store.write(
          ctx,
          {
            key,
            value: encoder.encode(JSON.stringify(decision)),
            metadata: Object.freeze({
              severity: decision.severity,
              queue: decision.queue
            })
          },
          ifAbsent()
        )
      } catch (error) {
        if (!isStoreAbsenceConflict(error)) throw error
        const current = await store.read(ctx, key)
        if (current === null) throw new Error("etcd alert decision conflict readback failed")
        const stored = storedDecision(current.value)
        if (
          current.metadata.severity !== stored.severity ||
          current.metadata.queue !== stored.queue
        ) {
          throw new Error("stored etcd alert decision is invalid")
        }
        if (!sameAlert(stored, decision)) throw alertIdConflict()
        return stored
      }
      const fresh = await store.read(ctx, written.key)
      if (
        fresh === null ||
        fresh.revision !== written.revision ||
        fresh.metadata.severity !== decision.severity ||
        fresh.metadata.queue !== decision.queue
      ) {
        throw new Error("etcd alert decision readback failed")
      }
      const stored = storedDecision(fresh.value)
      if (!sameDecision(stored, decision)) throw new Error("etcd alert decision readback failed")
      return stored
    }
  })
}
