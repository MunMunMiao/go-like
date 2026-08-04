import type { ConfigObject, ConfigSchema, ConfigValue } from "@go-like/config"

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

/** Parses one exact tenant policy from the configuration domain. */
function parseTenantPolicy(value: ConfigValue | undefined): TenantPolicy | null {
  if (!configObject(value)) return null
  const enabled = value.enabled
  const plan = value.plan
  const rateLimit = value.rateLimit
  const features = parseFeatures(value.features)
  if (
    typeof enabled !== "boolean" ||
    typeof plan !== "string" ||
    !isTenantToken(plan) ||
    !configObject(rateLimit) ||
    !positiveInteger(rateLimit.capacity) ||
    !positiveInteger(rateLimit.refillTokens) ||
    !positiveInteger(rateLimit.refillIntervalMs) ||
    features === null
  ) {
    return null
  }
  return Object.freeze({
    enabled,
    plan,
    features,
    rateLimit: Object.freeze({
      capacity: rateLimit.capacity,
      refillTokens: rateLimit.refillTokens,
      refillIntervalMs: rateLimit.refillIntervalMs
    })
  })
}

/** Validates and detaches the complete tenant configuration document. */
function validateTenantDocument(input: ConfigObject): TenantDocument | null {
  const schemaVersion = input.schemaVersion
  const generation = input.generation
  const cacheTtlMs = input.cacheTtlMs
  const tenantsValue = input.tenants
  if (
    schemaVersion !== 1 ||
    typeof generation !== "string" ||
    !isTenantToken(generation) ||
    !positiveInteger(cacheTtlMs) ||
    !configObject(tenantsValue)
  ) {
    return null
  }
  const tenants: Record<string, TenantPolicy> = {}
  for (const [tenantId, value] of Object.entries(tenantsValue)) {
    const policy = parseTenantPolicy(value)
    if (!isTenantToken(tenantId) || policy === null) return null
    tenants[tenantId] = policy
  }
  return Object.freeze({
    schemaVersion: 1,
    generation,
    cacheTtlMs,
    tenants: Object.freeze(tenants)
  })
}

/** Implements the Standard Schema contract used by Config publication. */
export const tenantDocumentSchema: ConfigSchema<TenantDocument> = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "@go-like/example-saas-tenant-api",
    validate(value: unknown) {
      const parsed = configObject(value) ? validateTenantDocument(value) : null
      return parsed === null
        ? { issues: [{ message: "invalid tenant configuration document" }] }
        : { value: parsed }
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
