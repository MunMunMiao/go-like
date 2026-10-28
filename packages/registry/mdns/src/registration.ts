import { type ServiceInstance } from "@go-like/registry"
import { snapshotServiceInstance } from "@go-like/registry/provider"

import { hostLabel, identityLabel, serviceLabel } from "./canonical"
import { encodeInstanceTXT } from "./codec"
import { encodeDNSPacket, validateDNSName, type DNSRecord } from "./dns"

/** Describes one parsed IP-literal ServiceInstance endpoint. */
export interface ParsedInstanceAddress {
  readonly family: "ipv4" | "ipv6"
  readonly address: string
  readonly port: number
}

/** Validates one parsed address through the actual DNS address encoder. */
function validateAddress(family: "ipv4" | "ipv6", address: string): void {
  encodeDNSPacket(
    {
      id: 0,
      response: true,
      questions: [],
      answers: [
        {
          name: "address.go-like.",
          type: family === "ipv4" ? "A" : "AAAA",
          ttl: 1,
          flush: true,
          data: address
        }
      ],
      authorities: [],
      additionals: []
    },
    512
  )
}

/** Resolves one URL's explicit or standard Web port. */
function endpointPort(value: URL): number {
  if (value.port.length > 0) return Number(value.port)
  if (value.protocol === "http:" || value.protocol === "ws:") return 80
  if (value.protocol === "https:" || value.protocol === "wss:") return 443
  throw new TypeError("mDNS endpoint must include a port for a non-Web scheme")
}

/** Parses one absolute ServiceInstance endpoint into an IP-literal address. */
export function parseInstanceAddress(value: string): ParsedInstanceAddress {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError("mDNS endpoint must be an absolute URL")
  }
  const hostname =
    endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]")
      ? endpoint.hostname.slice(1, -1)
      : endpoint.hostname
  const family = hostname.includes(":") ? "ipv6" : "ipv4"
  validateAddress(family, hostname)
  return Object.freeze({
    family,
    address: hostname.toLowerCase(),
    port: endpointPort(endpoint)
  })
}

/** Parses all endpoints and enforces one shared SRV port. */
export function parseInstanceAddresses(
  value: ServiceInstance
): readonly [ParsedInstanceAddress, ...ParsedInstanceAddress[]] {
  const instance = snapshotServiceInstance(value)
  const firstValue = instance.endpoints[0]
  if (firstValue === undefined) throw new TypeError("mDNS ServiceInstance must contain an endpoint")
  const first = parseInstanceAddress(firstValue)
  const result: [ParsedInstanceAddress, ...ParsedInstanceAddress[]] = [first]
  const seen = new Set<string>([JSON.stringify([first.family, first.address, first.port])])
  for (const endpoint of instance.endpoints.slice(1)) {
    const parsed = parseInstanceAddress(endpoint)
    if (first.port !== parsed.port) {
      throw new TypeError("mDNS ServiceInstance endpoints must share one SRV port")
    }
    const key = JSON.stringify([parsed.family, parsed.address, parsed.port])
    if (!seen.has(key)) result.push(parsed)
    seen.add(key)
  }
  return Object.freeze(result)
}

/** Converts one normalized FQDN into its constituent labels. */
function domainLabels(domain: string): readonly string[] {
  if (typeof domain !== "string" || !domain.endsWith(".")) {
    throw new TypeError("mDNS domain must be an FQDN")
  }
  return Object.freeze(domain.slice(0, -1).split("."))
}

/** Joins fixed record-owner labels to one normalized domain. */
function ownerLabels(prefixes: readonly string[], labels: readonly string[]): readonly string[] {
  const joined: string[] = []
  for (const prefix of prefixes) joined.push(prefix)
  for (const label of labels) joined.push(label)
  return joined
}

/** Builds the complete fixed go-like RR set for one ServiceInstance. */
export async function instanceRecords(
  value: ServiceInstance,
  domain: string,
  ttlSeconds: number,
  maximumDecodedBytes: number
): Promise<readonly DNSRecord[]> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 4_294_967_295) {
    throw new RangeError("mDNS record TTL is out of range")
  }
  const instance = snapshotServiceInstance(value)
  const parsed = parseInstanceAddresses(instance)
  const labels = domainLabels(domain)
  const serviceNameLabel = await serviceLabel(instance.name)
  const identityNameLabel = await identityLabel(instance)
  const hostNameLabel = await hostLabel(instance)
  const listOwner = validateDNSName(ownerLabels(["_services"], labels))
  const serviceOwner = validateDNSName(ownerLabels([serviceNameLabel], labels))
  const instanceOwner = validateDNSName(ownerLabels([identityNameLabel, serviceNameLabel], labels))
  const hostOwner = validateDNSName(ownerLabels([hostNameLabel], labels))
  const nameTXT = new TextEncoder().encode(`Go-Like-Service-Name=${instance.name}`)
  if (nameTXT.byteLength > 255) throw new RangeError("mDNS service name TXT exceeds 255 bytes")
  const records: DNSRecord[] = [
    Object.freeze({
      name: listOwner,
      type: "PTR",
      ttl: ttlSeconds,
      flush: false,
      data: serviceOwner
    }),
    Object.freeze({
      name: serviceOwner,
      type: "TXT",
      ttl: ttlSeconds,
      flush: false,
      data: Object.freeze([nameTXT])
    }),
    Object.freeze({
      name: serviceOwner,
      type: "PTR",
      ttl: ttlSeconds,
      flush: false,
      data: instanceOwner
    }),
    Object.freeze({
      name: instanceOwner,
      type: "SRV",
      ttl: ttlSeconds,
      flush: true,
      data: Object.freeze({
        priority: 0,
        weight: 0,
        port: parsed[0].port,
        target: hostOwner
      })
    }),
    Object.freeze({
      name: instanceOwner,
      type: "TXT",
      ttl: ttlSeconds,
      flush: true,
      data: await encodeInstanceTXT(instance, maximumDecodedBytes)
    })
  ]
  for (const address of parsed) {
    records.push(
      Object.freeze({
        name: hostOwner,
        type: address.family === "ipv4" ? "A" : "AAAA",
        ttl: ttlSeconds,
        flush: true,
        data: address.address
      })
    )
  }
  return Object.freeze(records)
}
