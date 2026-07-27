import { newConfig, source, objectSource, type Config, type ConfigObject } from "@likego/config"
import { etcdSource } from "@likego/config-etcd"
import type { Context } from "@likego/context"
import { newProbeRegistry, type ProbeRegistry } from "@likego/health"
import type { Store } from "@likego/store"
import { newEtcdStore } from "@likego/store-etcd"

import { validateTriageRules, type TriageDecision, type TriageRules } from "./service"

export interface AlertTriageLedger {
  record(ctx: Context, decision: TriageDecision): Promise<TriageDecision>
}

export interface TriageEtcdOptions {
  readonly address: string
  readonly configKey: string
}

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

/** Creates the immutable SOC rule source and LikeGo Config lifecycle. */
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
          throw new Error("alertId already used by different alert facts")
        }
        return current
      }
      decisions.set(decision.alertId, decision)
      return decision
    }
  })
}

/** Mirrors accepted process-local decisions into real etcd Store records. */
export function newEtcdAlertTriageLedger(options: TriageEtcdOptions): AlertTriageLedger {
  const primary = newMemoryAlertTriageLedger()
  const store: Store = newEtcdStore({
    fetch(request) {
      return fetch(request)
    },
    address: options.address
  })
  const encoder = new TextEncoder()
  return Object.freeze({
    async record(ctx: Context, decision: TriageDecision): Promise<TriageDecision> {
      const accepted = await primary.record(ctx, decision)
      const written = await store.write(ctx, {
        key: `security-alerts/${accepted.alertId}`,
        value: encoder.encode(JSON.stringify(accepted)),
        metadata: Object.freeze({ severity: accepted.severity, queue: accepted.queue })
      })
      const fresh = await store.read(ctx, written.key)
      if (
        fresh === null ||
        fresh.revision !== written.revision ||
        fresh.metadata.severity !== accepted.severity ||
        fresh.metadata.queue !== accepted.queue
      ) {
        throw new Error("etcd alert decision readback failed")
      }
      return accepted
    }
  })
}
