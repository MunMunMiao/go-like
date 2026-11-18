import type { ConfigObject, ConfigSchema, ConfigValue } from "@go-like/core/config"
import { struct } from "@go-like/core/struct"

/** Safe tokens accepted in tenant configuration and public projections. */
const TenantToken = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Declares one tenant-local token bucket policy. */
export interface TenantRateLimit extends ConfigObject {
  readonly capacity: number
  readonly refillTokens: number
  readonly refillIntervalMs: number
}

/** Declares the public and operational policy for one tenant. */
export interface TenantPolicy extends ConfigObject {
  readonly enabled: boolean
  readonly plan: string
  readonly features: Readonly<Record<string, boolean>>
  readonly rateLimit: TenantRateLimit
}

/** Declares the single complete Consul document consumed by this example. */
export interface TenantDocument extends ConfigObject {
  readonly schemaVersion: 1
  readonly generation: string
  readonly cacheTtlMs: number
  readonly tenants: Readonly<Record<string, TenantPolicy>>
}

/** Declares the only public tenant response. */
export interface TenantResponse {
  readonly tenantId: string
  readonly generation: string
  readonly plan: string
  readonly features: Readonly<Record<string, boolean>>
}

/** Reports whether one value is a safe tenant-domain token. */
export function isTenantToken(value: string): boolean {
  return TenantToken.test(value)
}

/** Returns whether one Config value is a non-array configuration object. */
function configObject(value: unknown): value is ConfigObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
}

/** Returns whether one number is a positive safe integer. */
function positiveInteger(value: ConfigValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** Parses one feature flag object without retaining the input object. */
export function parseFeatures(value: unknown): Readonly<Record<string, boolean>> | null {
  if (!configObject(value)) return null
  const features: Record<string, boolean> = {}
  for (const [name, enabled] of Object.entries(value)) {
    if (!isTenantToken(name) || typeof enabled !== "boolean") return null
    features[name] = enabled
  }
  return Object.freeze(features)
}

const tenantDocumentStruct = struct.object({
  schemaVersion: struct.literal(1),
  generation: struct.string(),
  cacheTtlMs: struct.number(),
  tenants: struct.record(
    struct.object({
      enabled: struct.boolean(),
      plan: struct.string(),
      features: struct.record(struct.boolean()),
      rateLimit: struct.object({
        capacity: struct.number(),
        refillTokens: struct.number(),
        refillIntervalMs: struct.number()
      })
    })
  )
})

interface ParsedTenantDocument {
  readonly schemaVersion: 1
  readonly generation: string
  readonly cacheTtlMs: number
  readonly tenants: {
    readonly [key: string]: {
      readonly enabled: boolean
      readonly plan: string
      readonly features: { readonly [key: string]: boolean }
      readonly rateLimit: {
        readonly capacity: number
        readonly refillTokens: number
        readonly refillIntervalMs: number
      }
    }
  }
}

/** Rejects one issue list with the stable tenant-document message. */
function invalidTenantDocument(): { readonly issues: readonly [{ readonly message: string }] } {
  return { issues: [{ message: "invalid tenant configuration document" }] }
}

/** Keeps token and positive-integer rules struct.object cannot express, and detaches the value. */
function acceptTenantDocument(value: ParsedTenantDocument): TenantDocument | null {
  if (!isTenantToken(value.generation) || !positiveInteger(value.cacheTtlMs)) return null
  const tenants: Record<string, TenantPolicy> = {}
  for (const [tenantId, policy] of Object.entries(value.tenants)) {
    const limit = policy.rateLimit
    if (
      !isTenantToken(tenantId) ||
      !isTenantToken(policy.plan) ||
      !Object.keys(policy.features).every((name) => isTenantToken(name)) ||
      !positiveInteger(limit.capacity) ||
      !positiveInteger(limit.refillTokens) ||
      !positiveInteger(limit.refillIntervalMs)
    ) {
      return null
    }
    tenants[tenantId] = Object.freeze({
      enabled: policy.enabled,
      plan: policy.plan,
      features: Object.freeze({ ...policy.features }),
      rateLimit: Object.freeze({
        capacity: limit.capacity,
        refillTokens: limit.refillTokens,
        refillIntervalMs: limit.refillIntervalMs
      })
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    generation: value.generation,
    cacheTtlMs: value.cacheTtlMs,
    tenants: Object.freeze(tenants)
  })
}

/** Implements the Standard Schema contract used by Config publication. */
export const tenantDocumentSchema: ConfigSchema<TenantDocument> = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "go-like",
    validate(value: unknown) {
      const parsed = tenantDocumentStruct["~standard"].validate(value) as
        | { readonly value: ParsedTenantDocument }
        | { readonly issues: readonly { readonly message: string }[] }
      if (!("value" in parsed)) return invalidTenantDocument()
      const accepted = acceptTenantDocument(parsed.value)
      return accepted === null ? invalidTenantDocument() : { value: accepted }
    }
  })
})

/** Selects one tenant policy without consulting inherited object properties. */
export function findTenantPolicy(document: TenantDocument, tenantId: string): TenantPolicy | null {
  return Object.hasOwn(document.tenants, tenantId) ? (document.tenants[tenantId] ?? null) : null
}

/** Builds the immutable public projection for one tenant. */
export function publicResponse(
  tenantId: string,
  generation: string,
  policy: TenantPolicy
): TenantResponse {
  return Object.freeze({
    tenantId,
    generation,
    plan: policy.plan,
    features: policy.features
  })
}
