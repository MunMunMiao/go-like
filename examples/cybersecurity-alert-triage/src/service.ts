import type { Config, ConfigObject } from "@likego/config"
import type { Context } from "@likego/context"
import type { ProbeRegistry } from "@likego/health"
import type { AlertTriageLedger } from "./config"

const publicId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export type AlertSource = "endpoint" | "identity" | "network"
export type AlertSeverity = "critical" | "high" | "low" | "medium"

export interface SecurityAlert {
  readonly alertId: string
  readonly source: AlertSource
  readonly failedAttempts: number
  readonly malwareConfidence: number
  readonly privileged: boolean
}

export interface TriageRules {
  readonly highFailedAttempts: number
  readonly criticalFailedAttempts: number
  readonly highMalwareConfidence: number
  readonly criticalMalwareConfidence: number
}

export interface TriageDecision extends SecurityAlert {
  readonly severity: AlertSeverity
  readonly queue: "immediate-response" | "investigation" | "review"
}

/** Validates a complete SOC triage rule set. */
export function validateTriageRules(rules: TriageRules): void {
  if (
    !Number.isSafeInteger(rules.highFailedAttempts) ||
    !Number.isSafeInteger(rules.criticalFailedAttempts) ||
    rules.highFailedAttempts < 1 ||
    rules.highFailedAttempts >= rules.criticalFailedAttempts
  ) {
    throw new RangeError("failed-attempt thresholds must increase from high to critical")
  }
  if (
    !Number.isFinite(rules.highMalwareConfidence) ||
    !Number.isFinite(rules.criticalMalwareConfidence) ||
    rules.highMalwareConfidence < 0 ||
    rules.criticalMalwareConfidence > 100 ||
    rules.highMalwareConfidence >= rules.criticalMalwareConfidence
  ) {
    throw new RangeError("malware thresholds must increase from high to critical")
  }
}

/** Validates one untrusted security alert before rules are applied. */
export function validateSecurityAlert(alert: SecurityAlert): void {
  if (!publicId.test(alert.alertId)) throw new TypeError("invalid alertId")
  if (alert.source !== "endpoint" && alert.source !== "identity" && alert.source !== "network") {
    throw new TypeError("unsupported alert source")
  }
  if (
    !Number.isSafeInteger(alert.failedAttempts) ||
    alert.failedAttempts < 0 ||
    alert.failedAttempts > 1_000_000
  ) {
    throw new RangeError("failedAttempts must be a non-negative safe count")
  }
  if (
    !Number.isFinite(alert.malwareConfidence) ||
    alert.malwareConfidence < 0 ||
    alert.malwareConfidence > 100
  ) {
    throw new RangeError("malwareConfidence must be between 0 and 100")
  }
  if (typeof alert.privileged !== "boolean") {
    throw new TypeError("privileged must be a boolean")
  }
}

/** Selects the highest severity produced by privilege, identity, and malware signals. */
export function triageSecurityAlert(alert: SecurityAlert, rules: TriageRules): TriageDecision {
  validateSecurityAlert(alert)
  validateTriageRules(rules)
  let severity: AlertSeverity = "low"
  if (alert.failedAttempts > 0 || alert.malwareConfidence > 0) severity = "medium"
  if (
    alert.failedAttempts >= rules.highFailedAttempts ||
    alert.malwareConfidence >= rules.highMalwareConfidence
  ) {
    severity = "high"
  }
  if (
    alert.privileged ||
    alert.failedAttempts >= rules.criticalFailedAttempts ||
    alert.malwareConfidence >= rules.criticalMalwareConfidence
  ) {
    severity = "critical"
  }
  const queue =
    severity === "critical"
      ? "immediate-response"
      : severity === "high"
        ? "investigation"
        : "review"
  return Object.freeze({
    alertId: alert.alertId,
    source: alert.source,
    failedAttempts: alert.failedAttempts,
    malwareConfidence: alert.malwareConfidence,
    privileged: alert.privileged,
    severity,
    queue
  })
}

export type TriageAlert = (ctx: Context, alert: SecurityAlert) => Promise<TriageDecision>

/** Reads one complete triage rule document from the current Config value. */
function currentRules(config: Config<ConfigObject>): TriageRules {
  const triage = config.value("triage").load()
  if (triage === null || typeof triage !== "object" || Array.isArray(triage)) {
    throw new Error("triage rules are invalid")
  }
  const highFailedAttempts = Reflect.get(triage, "highFailedAttempts")
  const criticalFailedAttempts = Reflect.get(triage, "criticalFailedAttempts")
  const highMalwareConfidence = Reflect.get(triage, "highMalwareConfidence")
  const criticalMalwareConfidence = Reflect.get(triage, "criticalMalwareConfidence")
  if (
    typeof highFailedAttempts !== "number" ||
    typeof criticalFailedAttempts !== "number" ||
    typeof highMalwareConfidence !== "number" ||
    typeof criticalMalwareConfidence !== "number"
  ) {
    throw new Error("triage rules are invalid")
  }
  return Object.freeze({
    highFailedAttempts,
    criticalFailedAttempts,
    highMalwareConfidence,
    criticalMalwareConfidence
  })
}

/** Creates a readiness-gated, Context-first security alert triage use case. */
export function newTriageAlert(
  config: Config<ConfigObject>,
  readiness: ProbeRegistry,
  ledger: AlertTriageLedger
): TriageAlert {
  return async function triageAlert(ctx: Context, alert: SecurityAlert): Promise<TriageDecision> {
    const report = await readiness.check(ctx, "ready")
    if (!report.ok) throw new Error("triage service is not ready")
    return ledger.record(ctx, triageSecurityAlert(alert, currentRules(config)))
  }
}
