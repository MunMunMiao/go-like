export interface IdentityLifecycleEvidence {
  readonly identityCount: number
  readonly createCount: number
  readonly updateCount: number
  readonly deleteCount: number
}

export interface IPv6AliasEvidenceInput {
  readonly advertisedEndpoints: readonly string[]
  readonly packetSourceAddresses: readonly string[]
  readonly lifecycle: IdentityLifecycleEvidence
}

export interface IPv6AliasEvidence {
  readonly advertisedULAObserved: boolean
  readonly packetLinkLocalObserved: boolean
  readonly singleIdentityLifecycleObserved: boolean
  readonly aliasObserved: boolean
}

/** Extracts a normalized IPv6 literal from an endpoint URL or packet source. */
function ipv6Literal(value: string): string {
  let normalized = value.trim().toLowerCase()
  if (normalized.includes("://")) {
    try {
      normalized = new URL(normalized).hostname
    } catch {
      return ""
    }
  }
  const closing = normalized.indexOf("]")
  const literal =
    normalized.startsWith("[") && closing > 1 ? normalized.slice(1, closing) : normalized
  const zone = literal.indexOf("%")
  return zone < 0 ? literal : literal.slice(0, zone)
}

/** Reports whether one literal belongs to fc00::/7. */
function isUniqueLocal(value: string): boolean {
  const first = Number.parseInt(ipv6Literal(value).split(":", 1)[0] ?? "", 16)
  return Number.isInteger(first) && (first & 0xfe00) === 0xfc00
}

/** Reports whether one literal belongs to fe80::/10. */
function isLinkLocal(value: string): boolean {
  const first = Number.parseInt(ipv6Literal(value).split(":", 1)[0] ?? "", 16)
  return Number.isInteger(first) && (first & 0xffc0) === 0xfe80
}

/** Derives alias evidence solely from observed addresses and the exact primary identity lifecycle. */
export function evaluateIPv6AliasEvidence(input: IPv6AliasEvidenceInput): IPv6AliasEvidence {
  const advertisedULAObserved = input.advertisedEndpoints.some(isUniqueLocal)
  const packetLinkLocalObserved = input.packetSourceAddresses.some(isLinkLocal)
  const singleIdentityLifecycleObserved =
    input.lifecycle.identityCount === 1 &&
    input.lifecycle.createCount === 1 &&
    input.lifecycle.updateCount === 2 &&
    input.lifecycle.deleteCount === 1
  return Object.freeze({
    advertisedULAObserved,
    packetLinkLocalObserved,
    singleIdentityLifecycleObserved,
    aliasObserved:
      advertisedULAObserved && packetLinkLocalObserved && singleIdentityLifecycleObserved
  })
}
