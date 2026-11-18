import type { ConfigObject, ConfigSchema } from "@go-like/core/config"
import { struct } from "@go-like/core/struct"

export interface RuntimeConfig extends ConfigObject {
  readonly release: number
  readonly feature: ConfigObject & { readonly enabled: boolean }
}

const runtimeConfigStruct = struct.object({
  release: struct.number(),
  feature: struct.object({
    enabled: struct.boolean()
  })
})

interface ParsedRuntimeConfig {
  readonly release: number
  readonly feature: { readonly enabled: boolean }
}

/** Validates the complete Vault document before Config publishes it. */
export const runtimeConfigSchema: ConfigSchema<RuntimeConfig> = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "go-like",
    validate(value: unknown) {
      const parsed = runtimeConfigStruct["~standard"].validate(value) as
        | { readonly value: ParsedRuntimeConfig }
        | { readonly issues: readonly { readonly message: string }[] }
      if (!("value" in parsed)) return parsed
      if (!Number.isSafeInteger(parsed.value.release)) {
        return { issues: [{ message: "runtime configuration is invalid" }] }
      }
      return {
        value: Object.freeze({
          release: parsed.value.release,
          feature: Object.freeze({ enabled: parsed.value.feature.enabled })
        })
      }
    }
  })
})
