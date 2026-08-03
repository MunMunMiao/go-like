import { type ServiceInstance } from "@likego/registry"
import { newRegistryProtocolError, snapshotServiceInstance } from "@likego/registry/provider"

import { kubernetesPodOwner } from "./options"
import type { KubernetesPodOwner } from "./types"

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567"
const wireMarker = "likego.registry-kubernetes.v2"
const maximumPayloadBytes = 196_608

export const managedByLabel = "endpointslice.kubernetes.io/managed-by"
export const managedByValue = "registry-kubernetes.likego.dev"
export const serviceNameLabel = "kubernetes.io/service-name"
export const identityLabel = "registry.likego.dev/identity"
export const wireAnnotation = "registry.likego.dev/wire-version"
export const instanceAnnotation = "registry.likego.dev/service-instance"
export const contentAnnotation = "registry.likego.dev/content"

/** Describes one EndpointSlice-compatible address family. */
export type AddressType = "IPv4" | "IPv6" | "FQDN"

/** Captures one validated immutable EndpointSlice mutation candidate. */
export interface SliceCandidate {
  readonly identity: string
  readonly content: string
  readonly serviceLabel: string
  readonly name: string
  readonly instance: ServiceInstance
  readonly addressType: AddressType
  readonly addresses: readonly string[]
  readonly port: number
}

/** Captures one verified LikeGo-managed EndpointSlice. */
export interface ManagedSlice extends SliceCandidate {
  readonly owner: KubernetesPodOwner | null
  readonly resourceVersion: string
}

/** Captures one consistent namespace list and its continuation revision. */
export interface SliceSnapshot {
  readonly resourceVersion: string
  readonly records: readonly ManagedSlice[]
}

/** Reads one own data property without invoking inherited accessors. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one unknown JSON carrier to a non-array object. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw newRegistryProtocolError(message)
  }
  return value
}

/** Reads one required non-empty string property. */
function string(value: object, key: string, message: string): string {
  const result = property(value, key)
  if (typeof result !== "string" || result.length === 0) {
    throw newRegistryProtocolError(message)
  }
  return result
}

/** Encodes bytes as lowercase RFC 4648 Base32 without padding. */
function base32(bytes: Uint8Array): string {
  let output = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += base32Alphabet.charAt((buffer >>> bits) & 31)
    }
  }
  if (bits > 0) output += base32Alphabet.charAt((buffer << (5 - bits)) & 31)
  return output
}

/** Hashes one canonical JSON preimage into a DNS-safe token. */
async function hash(marker: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([marker, value]))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return base32(new Uint8Array(digest))
}

/** Reports whether one host is canonical dotted-decimal IPv4. */
function ipv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return false
  }
  return true
}

/** Reports whether one IPv4 address is forbidden by EndpointSlice validation. */
function forbiddenIPv4(host: string): boolean {
  const parts = host.split(".").map(Number)
  const first = parts[0] ?? -1
  const second = parts[1] ?? -1
  return (
    first === 0 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first >= 224 && first <= 239) ||
    host === "255.255.255.255"
  )
}

/** Reports whether one IPv6 literal is forbidden by EndpointSlice validation. */
function forbiddenIPv6(host: string): boolean {
  const normalized = host.toLowerCase()
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  )
}

/** Reports whether one host is a Kubernetes-compatible DNS subdomain. */
function hostname(host: string): boolean {
  if (host.length < 1 || host.length > 253) return false
  for (const label of host.split(".")) {
    if (label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(label)) {
      return false
    }
  }
  return true
}

/** Produces a stable valid FQDN when an endpoint URL has no native Kubernetes address. */
function fallbackHost(identity: string): string {
  return `${identity.slice(3, 23)}.registry.likego.invalid`
}

/** Projects the first endpoint URL to the EndpointSlice validation fields. */
function projection(
  instance: ServiceInstance,
  identity: string
): {
  readonly addressType: AddressType
  readonly addresses: readonly string[]
  readonly port: number
} {
  const endpoint = instance.endpoints[0]
  if (endpoint === undefined) {
    return Object.freeze({
      addressType: "FQDN",
      addresses: Object.freeze([fallbackHost(identity)]),
      port: 1
    })
  }
  const parsed = new URL(endpoint)
  const port =
    parsed.port.length !== 0
      ? Number(parsed.port)
      : parsed.protocol === "http:"
        ? 80
        : parsed.protocol === "https:"
          ? 443
          : 1
  const host =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname
  if (ipv4(host) && !forbiddenIPv4(host)) {
    return Object.freeze({
      addressType: "IPv4",
      addresses: Object.freeze([host]),
      port
    })
  }
  if (host.includes(":") && !host.includes("%") && !forbiddenIPv6(host)) {
    return Object.freeze({
      addressType: "IPv6",
      addresses: Object.freeze([host]),
      port
    })
  }
  const address =
    !ipv4(host) && !host.includes(":") && hostname(host) ? host : fallbackHost(identity)
  return Object.freeze({
    addressType: "FQDN",
    addresses: Object.freeze([address]),
    port
  })
}

/** Encodes one ServiceInstance into a complete immutable mutation candidate. */
export async function encodeCandidate(value: ServiceInstance): Promise<SliceCandidate> {
  const instance = snapshotServiceInstance(value)
  const payload = JSON.stringify([wireMarker, instance])
  if (new TextEncoder().encode(payload).length > maximumPayloadBytes) {
    throw new RangeError(`Kubernetes service payload exceeds ${maximumPayloadBytes} bytes`)
  }
  const [identityHash, contentHash, serviceHash] = await Promise.all([
    hash("likego.registry-kubernetes.identity.v2", [instance.name, instance.id]),
    hash("likego.registry-kubernetes.content.v2", instance),
    hash("likego.registry-kubernetes.service.v2", instance.name)
  ])
  const identity = `ki-${identityHash}`
  const projected = projection(instance, identity)
  return Object.freeze({
    identity,
    content: `kc-${contentHash}`,
    serviceLabel: `ks-${serviceHash}`,
    name: `likego-${identityHash}`,
    instance,
    addressType: projected.addressType,
    addresses: projected.addresses,
    port: projected.port
  })
}

/** Produces one complete canonical EndpointSlice mutation body. */
export function encodeSlice(
  candidate: SliceCandidate,
  namespace: string,
  resourceVersion: string | null,
  owner: KubernetesPodOwner | null = null
): string {
  const metadata: Record<string, unknown> = {
    name: candidate.name,
    namespace,
    labels: {
      [managedByLabel]: managedByValue,
      [serviceNameLabel]: candidate.serviceLabel,
      [identityLabel]: candidate.identity
    },
    annotations: {
      [wireAnnotation]: "2",
      [instanceAnnotation]: JSON.stringify([wireMarker, candidate.instance]),
      [contentAnnotation]: candidate.content
    }
  }
  if (owner !== null) {
    metadata.ownerReferences = [
      {
        apiVersion: "v1",
        kind: "Pod",
        name: owner.name,
        uid: owner.uid
      }
    ]
  }
  if (resourceVersion !== null) metadata.resourceVersion = resourceVersion
  return JSON.stringify({
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata,
    addressType: candidate.addressType,
    endpoints: [{ addresses: candidate.addresses }],
    ports: [{ name: "likego", protocol: "TCP", port: candidate.port }]
  })
}

/** Decodes the sole supported same-namespace Pod owner reference. */
function decodeOwner(metadata: object): KubernetesPodOwner | null {
  const references = property(metadata, "ownerReferences")
  if (references === undefined) return null
  if (!Array.isArray(references) || references.length !== 1) {
    throw newRegistryProtocolError("Kubernetes managed EndpointSlice ownerReferences are invalid")
  }
  const reference = object(
    references[0],
    "Kubernetes managed EndpointSlice ownerReference is invalid"
  )
  if (property(reference, "apiVersion") !== "v1" || property(reference, "kind") !== "Pod") {
    throw newRegistryProtocolError("Kubernetes managed EndpointSlice owner must be a Pod")
  }
  try {
    return kubernetesPodOwner({
      name: string(reference, "name", "Kubernetes managed EndpointSlice owner name is invalid"),
      uid: string(reference, "uid", "Kubernetes managed EndpointSlice owner uid is invalid")
    })
  } catch (cause) {
    throw newRegistryProtocolError(
      "Kubernetes managed EndpointSlice Pod owner is invalid",
      cause as Error
    )
  }
}

/** Decodes and snapshots one managed payload annotation. */
function decodeInstance(value: string): ServiceInstance {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch (cause) {
    throw newRegistryProtocolError(
      "Kubernetes managed ServiceInstance annotation is not valid JSON",
      cause instanceof Error ? cause : undefined
    )
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== wireMarker) {
    throw newRegistryProtocolError("Kubernetes managed ServiceInstance marker is invalid")
  }
  try {
    return snapshotServiceInstance(decoded[1] as ServiceInstance)
  } catch (cause) {
    const source = cause instanceof Error ? cause : undefined
    throw newRegistryProtocolError("Kubernetes managed ServiceInstance is invalid", source)
  }
}

/** Verifies one exact array of strings. */
function stringArray(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw newRegistryProtocolError(message)
  }
  return value
}

/** Decodes one EndpointSlice when it belongs to this provider. */
export async function decodeManagedSlice(
  value: unknown,
  namespace: string
): Promise<ManagedSlice | null> {
  const carrier = object(value, "Kubernetes EndpointSlice is invalid")
  const metadata = object(
    property(carrier, "metadata"),
    "Kubernetes EndpointSlice metadata is invalid"
  )
  const labels = object(property(metadata, "labels"), "Kubernetes EndpointSlice labels are invalid")
  if (property(labels, managedByLabel) !== managedByValue) return null
  if (
    string(metadata, "namespace", "Kubernetes EndpointSlice namespace is invalid") !== namespace
  ) {
    throw newRegistryProtocolError("Kubernetes EndpointSlice escaped the configured namespace")
  }
  const annotations = object(
    property(metadata, "annotations"),
    "Kubernetes EndpointSlice annotations are invalid"
  )
  if (property(annotations, wireAnnotation) !== "2") {
    throw newRegistryProtocolError("Kubernetes managed wire version is unsupported")
  }
  const instance = decodeInstance(
    string(
      annotations,
      instanceAnnotation,
      "Kubernetes managed ServiceInstance annotation is missing"
    )
  )
  const candidate = await encodeCandidate(instance)
  if (
    string(metadata, "name", "Kubernetes EndpointSlice name is invalid") !== candidate.name ||
    property(labels, identityLabel) !== candidate.identity ||
    property(labels, serviceNameLabel) !== candidate.serviceLabel ||
    property(annotations, contentAnnotation) !== candidate.content
  ) {
    throw newRegistryProtocolError("Kubernetes managed EndpointSlice identity is inconsistent")
  }
  const addressType = property(carrier, "addressType")
  const endpoints = property(carrier, "endpoints")
  const ports = property(carrier, "ports")
  if (!Array.isArray(endpoints) || endpoints.length !== 1) {
    throw newRegistryProtocolError("Kubernetes managed EndpointSlice endpoints are invalid")
  }
  if (!Array.isArray(ports) || ports.length !== 1) {
    throw newRegistryProtocolError("Kubernetes managed EndpointSlice ports are invalid")
  }
  const endpoint = object(endpoints[0], "Kubernetes managed EndpointSlice endpoint is invalid")
  const port = object(ports[0], "Kubernetes managed EndpointSlice port is invalid")
  if (
    addressType !== candidate.addressType ||
    JSON.stringify(
      stringArray(
        property(endpoint, "addresses"),
        "Kubernetes managed EndpointSlice addresses are invalid"
      )
    ) !== JSON.stringify(candidate.addresses) ||
    property(port, "port") !== candidate.port
  ) {
    throw newRegistryProtocolError("Kubernetes managed EndpointSlice projection is inconsistent")
  }
  return Object.freeze({
    identity: candidate.identity,
    content: candidate.content,
    serviceLabel: candidate.serviceLabel,
    name: candidate.name,
    instance: candidate.instance,
    addressType: candidate.addressType,
    addresses: candidate.addresses,
    port: candidate.port,
    owner: decodeOwner(metadata),
    resourceVersion: string(
      metadata,
      "resourceVersion",
      "Kubernetes EndpointSlice resourceVersion is invalid"
    )
  })
}

/** Decodes one consistent EndpointSlice list and ignores foreign objects. */
export async function decodeSliceList(value: unknown, namespace: string): Promise<SliceSnapshot> {
  const carrier = object(value, "Kubernetes EndpointSliceList is invalid")
  const metadata = object(
    property(carrier, "metadata"),
    "Kubernetes EndpointSliceList metadata is invalid"
  )
  const items = property(carrier, "items")
  if (!Array.isArray(items)) {
    throw newRegistryProtocolError("Kubernetes EndpointSliceList items are invalid")
  }
  const records: ManagedSlice[] = []
  for (const item of items) {
    const decoded = await decodeManagedSlice(item, namespace)
    if (decoded !== null) records.push(decoded)
  }
  records.sort(
    /** Sorts managed records by their deterministic public identity. */
    function byIdentity(left, right): number {
      return Number(left.identity > right.identity) - Number(left.identity < right.identity)
    }
  )
  return Object.freeze({
    resourceVersion: string(
      metadata,
      "resourceVersion",
      "Kubernetes EndpointSliceList resourceVersion is invalid"
    ),
    records: Object.freeze(records)
  })
}
