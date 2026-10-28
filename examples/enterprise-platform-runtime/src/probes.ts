import type { ProbeRegistry } from "@go-like/health"

/** Registers the fixed public probe names used by the management plane. */
export function registerRuntimeProbes(registry: ProbeRegistry, ready: () => boolean): void {
  registry.register("live", "process", () => {})
  registry.register("ready", "service", () => {
    if (!ready()) throw new Error("service is not ready")
  })
}
