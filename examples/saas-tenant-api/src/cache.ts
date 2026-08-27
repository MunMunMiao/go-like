import { isTenantToken, parseFeatures, type TenantResponse } from "./config"

const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })

/** Encodes one public tenant response for cache storage. */
export function encodeCached(value: TenantResponse): Uint8Array {
  return Encoder.encode(JSON.stringify(value))
}

/** Decodes and verifies one cache payload against the active tenant generation. */
export function decodeCached(
  bytes: Uint8Array,
  tenantId: string,
  generation: string
): TenantResponse | null {
  try {
    const value: unknown = JSON.parse(Decoder.decode(bytes))
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const id = "tenantId" in value ? value.tenantId : undefined
    const cachedGeneration = "generation" in value ? value.generation : undefined
    const plan = "plan" in value ? value.plan : undefined
    const features = "features" in value ? parseFeatures(value.features) : null
    if (
      id !== tenantId ||
      cachedGeneration !== generation ||
      typeof plan !== "string" ||
      !isTenantToken(plan) ||
      features === null
    ) {
      return null
    }
    return Object.freeze({ tenantId, generation, plan, features })
  } catch {
    return null
  }
}
