import type { ConfigObject, ConfigSchema } from "@go-like/config"

export interface RuntimeConfig extends ConfigObject {
  readonly release: number
  readonly feature: ConfigObject & { readonly enabled: boolean }
}

/** Validates the complete Vault document before Config publishes it. */
export const runtimeConfigSchema: ConfigSchema<RuntimeConfig> = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "go-like-enterprise-example",
    validate(value: unknown) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "runtime configuration is invalid" }] }
      }
      const release = "release" in value ? value.release : undefined
      const feature = "feature" in value ? value.feature : undefined
      if (
        typeof release !== "number" ||
        !Number.isSafeInteger(release) ||
        feature === null ||
        typeof feature !== "object" ||
        Array.isArray(feature) ||
        !("enabled" in feature) ||
        typeof feature.enabled !== "boolean"
      ) {
        return { issues: [{ message: "runtime configuration is invalid" }] }
      }
      return {
        value: Object.freeze({
          release,
          feature: Object.freeze({ enabled: feature.enabled })
        })
      }
    }
  })
})
