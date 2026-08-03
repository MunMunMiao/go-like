import { background, type Context } from "@likego/context"
import * as Health from "../src/index"
import {
  newProbeRegistry,
  type Probe,
  type ProbeKind,
  type ProbeOptions,
  type ProbeRegistry,
  type ProbeReport,
  type ProbeResult
} from "../src/index"

const kind: ProbeKind = "ready"
const probe: Probe = (_ctx: Context) => {}
const options: ProbeOptions = { timeoutMs: 1 }
const result: ProbeResult = Object.freeze({ name: "x", ok: true, error: null })
const report: ProbeReport = Object.freeze({ kind, ok: true, checks: [result] })
const registry: ProbeRegistry = newProbeRegistry()
const unregister: () => boolean = registry.register("ready", "x", probe, options)
const checked: Promise<ProbeReport> = registry.check(background(), "ready")

void [report, unregister, checked]

// @ts-expect-error Public interfaces are type-only.
Health.ProbeRegistry
// @ts-expect-error Capitalized callable aliases are not exported.
Health.NewProbeRegistry()
// @ts-expect-error HTTP handlers belong to @likego/web/health.
Health.createHealthFetch(registry)
// @ts-expect-error Probe kinds are exact.
registry.register("startup", "x", probe)
