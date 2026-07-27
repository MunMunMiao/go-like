/// <reference lib="es2024.promise" />

import {
  background,
  cause,
  withCancelCause,
  withTimeout,
  type CancelCauseFunc,
  type Context
} from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"
import { type ServiceInstance, type Watcher } from "@likego/registry"
import {
  newRegistryProtocolError,
  newUnsupportedRegistryCapabilityError,
  notifyRegistrationError,
  snapshotServiceInstance,
  snapshotServiceInstances
} from "@likego/registry/provider"

import { newMDNSCache, type MDNSCache } from "./cache"
import { canonicalPayload, identityPreimage, serviceLabel } from "./canonical"
import { decodeInstanceTXT } from "./codec"
import {
  decodeDNSPacket,
  encodeDNSPacket,
  validateDNSName,
  type DNSPacket,
  type DNSQuestion,
  type DNSRecord,
  type DNSSRVData
} from "./dns"
import { mdnsOptions } from "./options"
import { instanceRecords, parseInstanceAddresses } from "./registration"
import { currentToken, currentTokenExcept, removeToken } from "./token-stack"
import type {
  MDNSAddress,
  MDNSDatagram,
  MDNSDatagramSocket,
  MDNSFamily,
  MDNSHost,
  MDNSMembership,
  MDNSNetworkInterface,
  MDNSOption,
  MDNSOptions,
  MDNSRegistry
} from "./types"
import { newSnapshotQueue, type SnapshotQueue } from "./watcher"

interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the deferred value exactly once. */
  readonly resolve: (value: T) => void
  /** Rejects the deferred value exactly once. */
  readonly reject: (reason?: unknown) => void
}

interface BoundResource {
  readonly family: MDNSFamily
  readonly interfaceId: string | number
  readonly socket: MDNSDatagramSocket
  readonly membership: MDNSMembership
}

interface WireService {
  readonly service: ServiceInstance
  readonly ttlSeconds: number
  readonly owner: string
}

interface CachedWireRecord {
  readonly record: DNSRecord
  readonly expiresAt: number
}

interface WirePublisherRecords {
  readonly records: Map<string, CachedWireRecord>
  touchedAt: number
}

interface WireRecordAccumulator {
  /** Adds one response fragment and returns only services backed by a complete canonical RR graph. */
  observe(datagram: MDNSDatagram, packet: DNSPacket): Promise<readonly WireService[]>
}

interface PublisherAliases {
  readonly ipv6: Map<string, string>
}

interface TokenRecord {
  readonly token: object
  readonly service: ServiceInstance
  readonly records: readonly DNSRecord[]
  readonly goodbye: readonly DNSRecord[]
  readonly identity: string
  active: boolean
}

interface RegistrationGroup {
  readonly tokens: readonly TokenRecord[]
  readonly resources: readonly BoundResource[]
  readonly terminal: Deferred<void>
  readonly owner: Context
  readonly cancelOwner: CancelCauseFunc
  readonly ttlMs: number
  refreshTimer: ReturnType<typeof setInterval> | null
  stopping: boolean
  quiescing: boolean
  cleanup: Promise<void> | null
  failed: Error | null
}

interface WatchOwner {
  readonly queue: SnapshotQueue
  readonly cache: MDNSCache
  readonly resources: readonly BoundResource[]
  readonly terminal: Deferred<void>
  readonly cancelOwner: CancelCauseFunc
  expiryTimer: ReturnType<typeof setInterval> | null
  cleanup: Promise<void> | null
  failure: Error | null
  stopping: boolean
}

interface ProviderState {
  readonly host: MDNSHost
  readonly provider: MDNSOptions
  readonly stacks: Map<string, TokenRecord[]>
  readonly groups: Set<RegistrationGroup>
  readonly registrations: Map<string, RegistrationGroup>
  mutation: Promise<void>
  registrationMutation: Promise<void>
}

/** Normalizes an untrusted boundary rejection without retaining a non-Error value. */
function normalizeBoundaryError(boundary: string, value: unknown): Error {
  return value instanceof Error ? value : new Error(`${boundary} failed with a non-Error value`)
}

/** Preserves one failure identity or aggregates ordered independent failures. */
function combineFailures(errors: readonly Error[], message: string): Error {
  const first = errors[0]
  if (errors.length === 1 && first !== undefined) return first
  const retained = Object.freeze(Array.from(errors))
  const aggregate = new AggregateError(retained, message)
  Object.defineProperty(aggregate, "errors", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: retained
  })
  return Object.freeze(aggregate)
}

/** Appends one independently observed failure without duplicating the same Error identity. */
function pushUniqueFailure(errors: Error[], failure: Error): void {
  if (!errors.includes(failure)) errors.push(failure)
}

/** Creates one externally settleable Promise pair. */
function deferred<T>(): Deferred<T> {
  return Object.freeze(Promise.withResolvers<T>())
}

/** Observes an intentionally published owner terminal rejection. */
function observeTerminal(_value: unknown): void {}

/** Throws the exact caller Context failure before performing admission work. */
function checkContext(ctx: Context): void {
  const error = cause(ctx)
  if (error !== null) throw error
}

/** Returns one multicast group address for a selected family. */
function multicastGroup(family: MDNSFamily): string {
  return family === "ipv4" ? "224.0.0.251" : "ff02::fb"
}

/** Returns one multicast target snapshot for a selected family and provider port. */
function multicastTarget(family: MDNSFamily, port: number): MDNSAddress {
  return Object.freeze({ family, address: multicastGroup(family), port })
}

/** Returns the constituent labels of one normalized provider domain. */
function providerLabels(options: MDNSOptions): readonly string[] {
  return Object.freeze(options.domain.slice(0, -1).split("."))
}

/** Creates a label list without relying on variadic array spread. */
function labels(prefixes: readonly string[], suffixes: readonly string[]): readonly string[] {
  const output: string[] = []
  for (const prefix of prefixes) output.push(prefix)
  for (const suffix of suffixes) output.push(suffix)
  return Object.freeze(output)
}

/** Returns the fixed list-services PTR owner. */
function listOwner(options: MDNSOptions): string {
  return validateDNSName(labels(["_services"], providerLabels(options)))
}

/** Returns the canonical PTR owner for one original service name. */
async function serviceOwner(name: string, options: MDNSOptions): Promise<string> {
  return validateDNSName(labels([await serviceLabel(name)], providerLabels(options)))
}

/** Creates one immutable DNS query packet. */
function queryPacket(questions: readonly DNSQuestion[]): DNSPacket {
  return Object.freeze({
    id: 0,
    response: false,
    questions: Object.freeze(Array.from(questions)),
    answers: Object.freeze([]),
    authorities: Object.freeze([]),
    additionals: Object.freeze([])
  })
}

/** Creates one immutable DNS response packet from an exact record set. */
function responsePacket(records: readonly DNSRecord[]): DNSPacket {
  return Object.freeze({
    id: 0,
    response: true,
    questions: Object.freeze([]),
    answers: records,
    authorities: Object.freeze([]),
    additionals: Object.freeze([])
  })
}

/** Splits one logical RR set into individually bounded multicast response packets. */
function boundedResponsePackets(
  records: readonly DNSRecord[],
  maximumBytes: number
): readonly DNSPacket[] {
  const packets: DNSPacket[] = []
  let pending: DNSRecord[] = []
  for (const record of records) {
    const candidate: DNSRecord[] = []
    for (const retained of pending) candidate.push(retained)
    candidate.push(record)
    try {
      encodeDNSPacket(responsePacket(candidate), maximumBytes)
      pending = candidate
    } catch (error) {
      if (!(error instanceof RangeError) || pending.length === 0) throw error
      packets.push(responsePacket(Object.freeze(pending)))
      encodeDNSPacket(responsePacket([record]), maximumBytes)
      pending = [record]
    }
  }
  if (pending.length > 0) packets.push(responsePacket(Object.freeze(pending)))
  return Object.freeze(packets)
}

/** Reports whether one TXT record carries the exact LikeGo v2 marker. */
function isManagedTXT(record: DNSRecord): boolean {
  if (record.type !== "TXT" || !Array.isArray(record.data)) return false
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (const item of record.data) {
    try {
      if (decoder.decode(item) === "Likego-Wire-Version=2") return true
    } catch {
      return false
    }
  }
  return false
}

/** Reports whether a managed owner belongs to a domain nested below this provider domain. */
function isNestedDomainOwner(name: string, domain: string): boolean {
  const suffix = `.${domain}`
  if (!name.endsWith(suffix)) return false
  const prefix = name.slice(0, -suffix.length)
  return prefix.split(".").length > 2
}

/** Creates one operation-local IPv6 source-address alias table. */
function newPublisherAliases(): PublisherAliases {
  return Object.freeze({ ipv6: new Map<string, string>() })
}

/** Removes an optional zone suffix from one received IPv6 address. */
function unscopedAddress(value: string): string {
  const separator = value.indexOf("%")
  return (separator < 0 ? value : value.slice(0, separator)).toLowerCase()
}

/** Returns one family/interface-scoped source-address key. */
function sourceAddressKey(datagram: MDNSDatagram, address: string): string {
  return JSON.stringify([
    datagram.remote.family,
    address,
    datagram.remote.port,
    datagram.interfaceId ?? null
  ])
}

/** Reports whether one decoded DNS payload is a TXT item list. */
function isTXTData(value: DNSRecord["data"]): value is readonly Uint8Array[] {
  return Array.isArray(value)
}

/** Reports whether one decoded DNS payload is structural SRV data. */
function isSRVData(value: DNSRecord["data"]): value is DNSSRVData {
  return (
    typeof value === "object" &&
    value !== null &&
    !isTXTData(value) &&
    "priority" in value &&
    "weight" in value &&
    "port" in value &&
    "target" in value
  )
}

/** Returns one deterministic DNS-record payload identity independent of TTL and cache-flush. */
function recordDataKey(record: DNSRecord): string {
  if (typeof record.data === "string") return JSON.stringify(record.data)
  if (isTXTData(record.data)) {
    const items: number[][] = []
    for (const item of record.data) items.push(Array.from(item))
    return JSON.stringify(items)
  }
  if (!isSRVData(record.data)) throw new TypeError("managed mDNS SRV payload is malformed")
  return JSON.stringify([
    record.data.priority,
    record.data.weight,
    record.data.port,
    record.data.target
  ])
}

/** Returns one cache key with unique-record replacement and multi-value PTR/address retention. */
function wireRecordKey(record: DNSRecord): string {
  if (record.type === "PTR" || record.type === "A" || record.type === "AAAA") {
    return JSON.stringify([record.name, record.type, recordDataKey(record)])
  }
  return JSON.stringify([record.name, record.type])
}

/** Reports canonical record identity independent of TTL. */
function sameWireRecordIdentity(left: DNSRecord, right: DNSRecord): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.flush === right.flush &&
    recordDataKey(left) === recordDataKey(right)
  )
}

/** Accepts exact graph TTLs plus retained positive shared RRs beside a TTL0 goodbye. */
function matchingGraphTTL(record: DNSRecord, ttlSeconds: number): boolean {
  return record.ttl === ttlSeconds || (ttlSeconds === 0 && !record.flush && record.ttl > 0)
}

/** Resolves the canonical service owner embedded in one identity owner. */
function identityServiceOwner(name: string, options: MDNSOptions): string | null {
  if (!name.endsWith(options.domain)) return null
  const prefix = name.slice(0, -options.domain.length)
  const labels = prefix.endsWith(".") ? prefix.slice(0, -1).split(".") : prefix.split(".")
  const identity = labels.slice(0, 1).join("")
  const service = labels.slice(1, 2).join("")
  if (labels.length !== 2 || !/^li-[a-z2-7]+$/.test(identity) || !/^ls-[a-z2-7]+$/.test(service))
    return null
  return `${service}.${options.domain}`
}

/** Reports whether cached fragments already contain the structural graph needed before async TXT decode. */
function structuralWireGraph(
  publisher: WirePublisherRecords,
  identityTXT: DNSRecord,
  options: MDNSOptions
): boolean {
  const serviceOwner = identityServiceOwner(identityTXT.name, options)
  if (serviceOwner === null) return false
  const srv = publisher.records.get(JSON.stringify([identityTXT.name, "SRV"]))?.record
  if (
    srv === undefined ||
    srv.type !== "SRV" ||
    !srv.flush ||
    !matchingGraphTTL(srv, identityTXT.ttl) ||
    !isSRVData(srv.data)
  )
    return false
  const serviceName = publisher.records.get(JSON.stringify([serviceOwner, "TXT"]))?.record
  if (
    serviceName === undefined ||
    serviceName.flush ||
    !matchingGraphTTL(serviceName, identityTXT.ttl)
  )
    return false
  const servicePointer = publisher.records.get(
    JSON.stringify([serviceOwner, "PTR", JSON.stringify(identityTXT.name)])
  )?.record
  if (
    servicePointer === undefined ||
    servicePointer.flush ||
    !matchingGraphTTL(servicePointer, identityTXT.ttl)
  )
    return false
  const list = `_services.${options.domain}`
  const listPointer = publisher.records.get(
    JSON.stringify([list, "PTR", JSON.stringify(serviceOwner)])
  )?.record
  if (
    listPointer === undefined ||
    listPointer.flush ||
    !matchingGraphTTL(listPointer, identityTXT.ttl)
  )
    return false
  for (const cached of publisher.records.values()) {
    const address = cached.record
    if (
      (address.type === "A" || address.type === "AAAA") &&
      address.name === srv.data.target &&
      address.flush &&
      matchingGraphTTL(address, identityTXT.ttl)
    )
      return true
  }
  return false
}

/** Creates one bounded operation-local fragment assembler keyed by packet source and interface. */
function newWireRecordAccumulator(options: MDNSOptions): WireRecordAccumulator {
  const publishers = new Map<string, WirePublisherRecords>()
  const maximumPublishers = 64
  const maximumRecordsPerPublisher = 256

  /** Drops expired fragments before one graph evaluation. */
  function prune(publisher: WirePublisherRecords, now: number): void {
    for (const [key, cached] of publisher.records) {
      if (cached.expiresAt <= now) publisher.records.delete(key)
    }
  }

  return Object.freeze({
    /** Accumulates split response packets without composing records across publishers or interfaces. */
    async observe(datagram: MDNSDatagram, packet: DNSPacket): Promise<readonly WireService[]> {
      const now = performance.now()
      const publisherKey = sourceAddressKey(datagram, unscopedAddress(datagram.remote.address))
      let publisher = publishers.get(publisherKey)
      if (publisher === undefined) {
        if (publishers.size >= maximumPublishers) {
          for (const oldest of publishers.keys()) {
            publishers.delete(oldest)
            break
          }
        }
        publisher = { records: new Map<string, CachedWireRecord>(), touchedAt: now }
        publishers.set(publisherKey, publisher)
      } else {
        publishers.delete(publisherKey)
        publishers.set(publisherKey, publisher)
        publisher.touchedAt = now
      }
      prune(publisher, now)
      const incoming: DNSRecord[] = []
      for (const record of packet.answers) incoming.push(record)
      for (const record of packet.authorities) incoming.push(record)
      for (const record of packet.additionals) incoming.push(record)
      for (const record of incoming) {
        if (!record.name.endsWith(options.domain)) continue
        const key = wireRecordKey(record)
        publisher.records.delete(key)
        publisher.records.set(
          key,
          Object.freeze({
            record,
            expiresAt: now + (record.ttl === 0 ? 1_000 : record.ttl * 1_000)
          })
        )
        while (publisher.records.size > maximumRecordsPerPublisher) {
          for (const oldest of publisher.records.keys()) {
            publisher.records.delete(oldest)
            break
          }
        }
      }

      const services: WireService[] = []
      for (const cached of publisher.records.values()) {
        const record = cached.record
        if (!isManagedTXT(record)) continue
        if (isNestedDomainOwner(record.name, options.domain)) continue
        if (identityServiceOwner(record.name, options) === null) {
          throw newRegistryProtocolError(
            "managed mDNS TXT owner does not match its canonical identity"
          )
        }
        if (!structuralWireGraph(publisher, record, options)) continue
        if (!Array.isArray(record.data))
          throw newRegistryProtocolError("managed mDNS TXT record is malformed")
        const service = await decodeInstanceTXT(record.data, options.maxDecodedPayloadBytes)
        const expected = await instanceRecords(
          service,
          options.domain,
          record.ttl,
          options.maxDecodedPayloadBytes
        )
        const identityTXT = expected.find(
          /** Selects the unique identity-scoped TXT record. */
          function matching(candidate): boolean {
            return candidate.type === "TXT" && candidate.flush
          }
        )
        if (identityTXT?.name !== record.name) {
          throw newRegistryProtocolError(
            "managed mDNS TXT owner does not match its canonical identity"
          )
        }
        let complete = true
        for (const expectedRecord of expected) {
          const actual = publisher.records.get(wireRecordKey(expectedRecord))?.record
          if (actual === undefined) {
            complete = false
            continue
          }
          if (
            actual.flush !== expectedRecord.flush ||
            recordDataKey(actual) !== recordDataKey(expectedRecord)
          ) {
            throw newRegistryProtocolError(
              "managed mDNS RR graph conflicts with its canonical service payload"
            )
          }
          if (!matchingGraphTTL(actual, expectedRecord.ttl)) complete = false
        }
        if (complete)
          services.push(Object.freeze({ service, ttlSeconds: record.ttl, owner: record.name }))
      }
      return Object.freeze(services)
    }
  })
}

/** Resolves global and link-local IPv6 source aliases through advertised endpoints. */
function publisherKey(
  datagram: MDNSDatagram,
  service: ServiceInstance,
  aliases: PublisherAliases
): string {
  const remoteAddress = unscopedAddress(datagram.remote.address)
  const remoteKey = sourceAddressKey(datagram, remoteAddress)
  if (datagram.remote.family !== "ipv6") return remoteKey
  const retained = aliases.ipv6.get(remoteKey)
  if (retained !== undefined) return retained
  const advertisedKeys: string[] = []
  for (const address of parseInstanceAddresses(service)) {
    if (address.family !== "ipv6") continue
    advertisedKeys.push(sourceAddressKey(datagram, unscopedAddress(address.address)))
  }
  let stable = remoteKey
  for (const advertisedKey of advertisedKeys) {
    const known = aliases.ipv6.get(advertisedKey)
    if (known !== undefined) {
      stable = known
      break
    }
  }
  aliases.ipv6.set(remoteKey, stable)
  for (const advertisedKey of advertisedKeys) {
    if (!aliases.ipv6.has(advertisedKey)) aliases.ipv6.set(advertisedKey, stable)
  }
  return stable
}

/** Validates and snapshots runtime interfaces returned by a borrowed host. */
function snapshotInterfaces(
  values: readonly MDNSNetworkInterface[]
): readonly MDNSNetworkInterface[] {
  if (!Array.isArray(values)) throw new TypeError("MDNSHost networkInterfaces must return an array")
  const output: MDNSNetworkInterface[] = []
  const keys = new Set<string>()
  for (const value of values) {
    if (
      typeof value !== "object" ||
      value === null ||
      (typeof value.id !== "string" && typeof value.id !== "number") ||
      typeof value.name !== "string" ||
      (value.family !== "ipv4" && value.family !== "ipv6") ||
      typeof value.address !== "string" ||
      typeof value.internal !== "boolean"
    )
      throw new TypeError("MDNSHost returned an invalid network interface")
    const key = JSON.stringify([value.id, value.family])
    if (keys.has(key)) throw new TypeError("MDNSHost returned a duplicate interface identity")
    keys.add(key)
    output.push(
      Object.freeze({
        id: value.id,
        name: value.name,
        family: value.family,
        address: value.address.toLowerCase(),
        internal: value.internal
      })
    )
  }
  return Object.freeze(output)
}

/** Selects exact interface/family plans before opening any socket. */
async function selectedInterfaces(
  ctx: Context,
  host: MDNSHost,
  options: MDNSOptions
): Promise<readonly MDNSNetworkInterface[]> {
  checkContext(ctx)
  const available = snapshotInterfaces(await host.networkInterfaces(ctx))
  checkContext(ctx)
  const selected: MDNSNetworkInterface[] = []
  const requested = new Set<string | number>()
  for (const id of options.interfaceIds) requested.add(id)
  const seenRequested = new Set<string | number>()
  for (const networkInterface of available) {
    if (networkInterface.internal) continue
    if (!options.families.includes(networkInterface.family)) continue
    if (requested.size > 0 && !requested.has(networkInterface.id)) continue
    selected.push(networkInterface)
    seenRequested.add(networkInterface.id)
  }
  for (const id of requested) {
    if (!seenRequested.has(id))
      throw new TypeError(`mDNS interface ${String(id)} is unknown or family-mismatched`)
  }
  for (const family of options.families) {
    if (
      !selected.some(
        /** Reports whether one selected interface satisfies the requested family. */
        function matches(item): boolean {
          return item.family === family
        }
      )
    ) {
      throw newUnsupportedRegistryCapabilityError(
        "mdns-interface-family",
        `no non-internal ${family} interface is available`
      )
    }
  }
  return Object.freeze(selected)
}

/** Binds, configures, and joins one socket for every selected interface/family. */
async function bindResources(
  ctx: Context,
  host: MDNSHost,
  options: MDNSOptions,
  selected?: readonly MDNSNetworkInterface[]
): Promise<readonly BoundResource[]> {
  const interfaces = selected ?? (await selectedInterfaces(ctx, host, options))
  const resources: BoundResource[] = []
  for (const networkInterface of interfaces) {
    try {
      checkContext(ctx)
    } catch (error) {
      return rejectResourceAdmission(error, null, resources)
    }
    let socket: MDNSDatagramSocket
    try {
      socket = await host.bindDatagram(
        ctx,
        Object.freeze({
          family: networkInterface.family,
          bindAddress: networkInterface.family === "ipv4" ? "0.0.0.0" : "::",
          port: options.port,
          interfaceId: networkInterface.id,
          interfaceAddress: networkInterface.address,
          reuseAddress: true,
          multicastTTL: 255
        })
      )
    } catch (error) {
      return rejectResourceAdmission(error, null, resources)
    }
    try {
      await socket.setMulticastLoopback(ctx, true)
      await socket.setMulticastInterface(ctx, networkInterface.id)
      const membership = await socket.joinMulticast(
        ctx,
        multicastGroup(networkInterface.family),
        networkInterface.id
      )
      resources.push(
        Object.freeze({
          family: networkInterface.family,
          interfaceId: networkInterface.id,
          socket,
          membership
        })
      )
    } catch (error) {
      await rejectResourceAdmission(error, socket, resources)
    }
  }
  return Object.freeze(resources)
}

/** Collects close and terminal failures while always waiting for the stable socket terminal. */
async function socketCleanupFailures(socket: MDNSDatagramSocket): Promise<readonly Error[]> {
  const failures: Error[] = []
  try {
    await socket.close(background())
  } catch (error) {
    pushUniqueFailure(failures, normalizeBoundaryError("mDNS socket close", error))
  }
  try {
    await socket.settled()
  } catch (error) {
    pushUniqueFailure(failures, normalizeBoundaryError("mDNS socket terminal", error))
  }
  return Object.freeze(failures)
}

/** Collects resource cleanup failures in reverse ownership order. */
async function resourceCleanupFailures(
  resources: readonly BoundResource[]
): Promise<readonly Error[]> {
  const failures: Error[] = []
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const resource = resources[index]
    if (resource === undefined) continue
    try {
      await resource.membership.leave(background())
    } catch (error) {
      pushUniqueFailure(failures, normalizeBoundaryError("mDNS membership leave", error))
    }
    for (const failure of await socketCleanupFailures(resource.socket))
      pushUniqueFailure(failures, failure)
  }
  return Object.freeze(failures)
}

/** Rejects admission only after every partially or fully accepted socket reaches its terminal. */
async function rejectResourceAdmission(
  primary: unknown,
  partial: MDNSDatagramSocket | null,
  resources: readonly BoundResource[]
): Promise<never> {
  const failures: Error[] = [normalizeBoundaryError("mDNS resource admission", primary)]
  if (partial !== null) {
    for (const failure of await socketCleanupFailures(partial)) pushUniqueFailure(failures, failure)
  }
  for (const failure of await resourceCleanupFailures(resources))
    pushUniqueFailure(failures, failure)
  throw combineFailures(failures, "mDNS resource admission rollback failed")
}

/** Leaves memberships and closes sockets in reverse ownership order. */
async function closeResources(resources: readonly BoundResource[]): Promise<void> {
  const failures = await resourceCleanupFailures(resources)
  if (failures.length > 0) throw combineFailures(failures, "mDNS resource cleanup failed")
}

/** Sends one packet through every owned interface socket. */
async function sendPacket(
  ctx: Context,
  resources: readonly BoundResource[],
  packet: DNSPacket,
  options: MDNSOptions
): Promise<void> {
  const data = encodeDNSPacket(packet, options.maxPacketBytes)
  for (const resource of resources) {
    await resource.socket.send(ctx, data, multicastTarget(resource.family, options.port))
  }
}

/** Sends each record set as an independently bounded DNS response. */
async function sendRecordSets(
  ctx: Context,
  resources: readonly BoundResource[],
  records: readonly (readonly DNSRecord[])[],
  options: MDNSOptions
): Promise<void> {
  for (const recordSet of records) {
    for (const packet of boundedResponsePackets(recordSet, options.maxPacketBytes)) {
      await sendPacket(ctx, resources, packet, options)
    }
  }
}

/** Filters shared goodbyes that still have another current local owner. */
function goodbyeAfterRemoval(
  state: ProviderState,
  token: TokenRecord,
  removed: ReadonlySet<TokenRecord>
): readonly DNSRecord[] {
  const records: DNSRecord[] = []
  for (const goodbye of token.goodbye) {
    let retained = false
    if (!goodbye.flush) {
      for (const stack of state.stacks.values()) {
        const survivor = currentTokenExcept(stack, removed)
        if (
          survivor !== null &&
          survivor.records.some(
            /** Reports whether this survivor owns the same shared wire record. */
            function sameIdentity(record): boolean {
              return sameWireRecordIdentity(goodbye, record)
            }
          )
        ) {
          retained = true
          break
        }
      }
    }
    if (!retained) records.push(goodbye)
  }
  return Object.freeze(records)
}

/** Returns the current tokens owned by one registration group. */
function currentTokens(
  state: ProviderState,
  owned: readonly TokenRecord[]
): readonly TokenRecord[] {
  const tokens: TokenRecord[] = []
  for (const token of owned) {
    if (token.active && currentToken(state.stacks.get(token.identity)) === token) tokens.push(token)
  }
  return Object.freeze(tokens)
}

/** Selects current owned record sets requested by one incoming DNS query. */
function requestedRecords(
  state: ProviderState,
  tokens: readonly TokenRecord[],
  packet: DNSPacket
): readonly (readonly DNSRecord[])[] {
  if (packet.response) return Object.freeze([])
  const records: (readonly DNSRecord[])[] = []
  for (const token of tokens) {
    if (!token.active || currentToken(state.stacks.get(token.identity)) !== token) continue
    let requested = false
    for (const question of packet.questions) {
      if (
        token.records.some(
          /** Reports whether one owned RR answers this exact question. */
          function matches(record): boolean {
            return (
              record.name === question.name &&
              (question.type === "ANY" || record.type === question.type)
            )
          }
        )
      ) {
        requested = true
      }
    }
    if (requested) records.push(token.records)
  }
  return Object.freeze(records)
}

/** Serializes one provider mutation after every previously admitted mutation. */
async function exclusive<T>(
  state: ProviderState,
  ctx: Context,
  operation: () => Promise<T>
): Promise<T> {
  const previous = state.mutation
  const release = deferred<void>()
  state.mutation = previous.then(
    /** Waits for this operation's explicit release after its predecessor. */
    function waitRelease(): Promise<void> {
      return release.promise
    }
  )
  try {
    await waitForContext(ctx, previous)
    checkContext(ctx)
    return await operation()
  } finally {
    release.resolve(undefined)
  }
}

/** Serializes public registration replacement and deregistration decisions. */
async function exclusiveRegistration<T>(
  state: ProviderState,
  ctx: Context,
  operation: () => Promise<T>
): Promise<T> {
  const previous = state.registrationMutation
  const release = deferred<void>()
  state.registrationMutation = previous.then(
    /** Waits for this public mutation's explicit release after its predecessor. */
    function waitRelease(): Promise<void> {
      return release.promise
    }
  )
  try {
    await waitForContext(ctx, previous)
    checkContext(ctx)
    return await operation()
  } finally {
    release.resolve(undefined)
  }
}

/** Receives packets until an operation timeout and invokes one response consumer. */
async function collectResponses(
  ctx: Context,
  resource: BoundResource,
  timeoutMs: number,
  maximumPacketBytes: number,
  consume: (datagram: MDNSDatagram, packet: DNSPacket) => Promise<void>
): Promise<void> {
  const [timed, cancel] = withTimeout(ctx, timeoutMs)
  try {
    while (timed.err() === null) {
      let datagram: MDNSDatagram
      try {
        datagram = await resource.socket.receive(timed)
      } catch (error) {
        if (timed.err() !== null) break
        throw error
      }
      let packet: DNSPacket
      try {
        packet = decodeDNSPacket(datagram.data, maximumPacketBytes)
      } catch {
        continue
      }
      if (packet.response) await consume(datagram, packet)
    }
    const failure = cause(ctx)
    if (failure !== null) throw failure
  } finally {
    cancel()
  }
}

/** Probes remote responders for one incompatible logical identity. */
async function probe(
  state: ProviderState,
  ctx: Context,
  resources: readonly BoundResource[],
  candidate: TokenRecord
): Promise<void> {
  const questions: DNSQuestion[] = []
  for (const record of candidate.records) {
    if (record.type === "PTR" && record.name !== listOwner(state.provider)) {
      questions.push(Object.freeze({ name: record.name, type: "PTR" }))
    } else if (record.type === "SRV") {
      questions.push(Object.freeze({ name: record.name, type: "SRV" }))
    }
  }
  await sendPacket(ctx, resources, queryPacket(questions), state.provider)
  const localIdentityExists = currentToken(state.stacks.get(candidate.identity)) !== null
  const wireRecords = newWireRecordAccumulator(state.provider)
  const collectors: Promise<void>[] = []
  for (const resource of resources) {
    collectors.push(
      collectResponses(
        ctx,
        resource,
        state.provider.queryTimeoutMs,
        state.provider.maxPacketBytes,
        /** Rejects any incompatible managed publication observed during admission probe. */
        async function compare(datagram, packet): Promise<void> {
          for (const remote of await wireRecords.observe(datagram, packet)) {
            const remoteIdentity = identityPreimage(remote.service)
            if (
              remoteIdentity === candidate.identity &&
              !localIdentityExists &&
              canonicalPayload(remote.service) !== canonicalPayload(candidate.service)
            ) {
              throw newRegistryProtocolError(
                "mDNS registration probe found an identity-content collision"
              )
            }
          }
        }
      )
    )
  }
  await Promise.all(collectors)
}

/** Fails one registration group on a passive owner-resource terminal. */
function failRegistration(state: ProviderState, group: RegistrationGroup, error: Error): void {
  if (group.stopping || group.failed !== null) return
  group.failed = error
  group.stopping = true
  if (group.refreshTimer !== null) {
    clearInterval(group.refreshTimer)
    group.refreshTimer = null
  }
  /** Closes every owned network resource before publishing the passive terminal. */
  async function finish(): Promise<void> {
    const failures: Error[] = [error]
    for (const failure of await resourceCleanupFailures(group.resources)) {
      pushUniqueFailure(failures, failure)
    }
    const terminalFailure = combineFailures(failures, "mDNS registration terminal failed")
    group.failed = terminalFailure
    group.terminal.reject(terminalFailure)
    throw terminalFailure
  }
  group.cleanup = Promise.resolve().then(finish)
  void group.cleanup.catch(observeTerminal)
  group.cancelOwner(error)
  for (const token of group.tokens) removeToken(state.stacks, token)
  state.groups.delete(group)
  for (const [identity, registered] of state.registrations) {
    if (registered === group) state.registrations.delete(identity)
  }
  for (const token of group.tokens) {
    notifyRegistrationError(state.provider.onRegistrationError, error, token.service)
  }
}

/** Starts response, goodbye rescue, and socket-terminal ownership loops. */
function startRegistrationLoops(
  state: ProviderState,
  group: RegistrationGroup,
  owner: Context
): void {
  for (const resource of group.resources) {
    void resource.socket.settled().then(
      /** Treats an unexpected clean socket terminal as passive owner loss. */
      function unexpectedClose(): void {
        if (!group.stopping)
          failRegistration(state, group, new Error("mDNS registration socket closed unexpectedly"))
      },
      /** Publishes the exact passive socket failure through the group terminal. */
      function socketFailure(error: unknown): void {
        failRegistration(state, group, normalizeBoundaryError("mDNS registration socket", error))
      }
    )
    /** Receives and answers DNS queries until owner cancellation or passive failure. */
    async function respond(): Promise<void> {
      while (owner.err() === null && !group.stopping) {
        let datagram: MDNSDatagram
        try {
          datagram = await resource.socket.receive(owner)
        } catch (error) {
          if (owner.err() !== null || group.stopping) return
          failRegistration(state, group, normalizeBoundaryError("mDNS registration receive", error))
          return
        }
        if (owner.err() !== null || group.stopping) return
        if (group.quiescing) continue
        let packet: DNSPacket
        try {
          packet = decodeDNSPacket(datagram.data, state.provider.maxPacketBytes)
        } catch {
          continue
        }
        if (!packet.response) {
          try {
            await sendRecordSets(
              owner,
              [resource],
              requestedRecords(state, group.tokens, packet),
              state.provider
            )
          } catch (error) {
            if (owner.err() === null && !group.stopping) {
              failRegistration(
                state,
                group,
                normalizeBoundaryError("mDNS registration response", error)
              )
            }
            return
          }
          continue
        }
        let rescue = false
        for (const record of packet.answers) {
          if (record.ttl !== 0) continue
          if (
            currentTokens(state, group.tokens).some(
              /** Reports whether one current token owns this goodbye RR key. */
              function owns(token): boolean {
                return token.records.some(
                  /** Compares one owned record by owner and RR type. */
                  function sameOwner(owned): boolean {
                    return owned.name === record.name && owned.type === record.type
                  }
                )
              }
            )
          )
            rescue = true
        }
        if (rescue) {
          try {
            const currentRecords = currentTokens(state, group.tokens).map(
              /** Returns one current token's complete record set. */
              function records(token) {
                return token.records
              }
            )
            await sendRecordSets(owner, [resource], currentRecords, state.provider)
          } catch (error) {
            if (owner.err() === null && !group.stopping) {
              failRegistration(state, group, normalizeBoundaryError("mDNS goodbye rescue", error))
            }
            return
          }
        }
      }
    }
    void respond()
  }
}

/** Creates and starts one registration refresh timer. */
function startRefresh(state: ProviderState, group: RegistrationGroup): void {
  if (
    group.refreshTimer !== null ||
    group.stopping ||
    group.failed !== null ||
    group.owner.err() !== null
  )
    return
  const interval = Math.max(1_000, Math.floor(group.ttlMs / 2))
  group.refreshTimer = setInterval(
    /** Refreshes only tokens that remain current for their exact identities. */
    function refresh(): void {
      if (group.stopping || group.quiescing || group.failed !== null || group.owner.err() !== null)
        return
      const records: (readonly DNSRecord[])[] = []
      for (const token of group.tokens) {
        if (token.active && currentToken(state.stacks.get(token.identity)) === token)
          records.push(token.records)
      }
      void sendRecordSets(group.owner, group.resources, records, state.provider).catch(
        /** Publishes refresh failure through the registration terminal. */
        function refreshFailure(error: unknown): void {
          failRegistration(state, group, normalizeBoundaryError("mDNS registration refresh", error))
        }
      )
    },
    interval
  )
}

/** Stops one registration group while preserving token ownership on send failure. */
async function stopRegistrationGroup(
  state: ProviderState,
  group: RegistrationGroup
): Promise<void> {
  if (group.failed !== null) throw group.failed
  group.quiescing = true
  if (group.refreshTimer !== null) {
    clearInterval(group.refreshTimer)
    group.refreshTimer = null
  }
  try {
    await exclusive(
      state,
      background(),
      /** Publishes every removal before committing this registration group's local ownership change. */
      async function removeTokens(): Promise<void> {
        const removed = new Set<TokenRecord>()
        for (let index = group.tokens.length - 1; index >= 0; index -= 1) {
          const token = group.tokens[index]
          if (token === undefined || !token.active) continue
          const stack = state.stacks.get(token.identity)
          const before = currentTokenExcept(stack, removed)
          removed.add(token)
          if (before === token) {
            const after = currentTokenExcept(stack, removed)
            await sendRecordSets(
              background(),
              group.resources,
              [after === null ? goodbyeAfterRemoval(state, token, removed) : after.records],
              state.provider
            )
          }
        }
        if (group.failed !== null) throw group.failed
        group.stopping = true
        for (const token of removed) removeToken(state.stacks, token)
      }
    )
  } catch (error) {
    group.quiescing = false
    if (group.failed !== null && group.cleanup !== null) return await group.cleanup
    startRefresh(state, group)
    throw error
  }
  group.quiescing = false
  group.cancelOwner(new Error("mDNS registration stopped"))
  let cleanupFailure: Error | null = null
  try {
    await closeResources(group.resources)
  } catch (error) {
    cleanupFailure = normalizeBoundaryError("mDNS registration cleanup", error)
  }
  state.groups.delete(group)
  if (cleanupFailure === null) group.terminal.resolve(undefined)
  else group.terminal.reject(cleanupFailure)
  if (cleanupFailure !== null) throw cleanupFailure
}

/** Stops one accepted registration while keeping physical ownership provider-private. */
function stopAcceptedRegistration(
  state: ProviderState,
  group: RegistrationGroup,
  ctx: Context
): Promise<void> {
  if (group.cleanup !== null) return waitForContext(ctx, group.cleanup)
  if (group.failed !== null) return waitForContext(ctx, Promise.reject(group.failed))
  const operation = stopRegistrationGroup(state, group)
  group.cleanup = operation
  void operation.catch(
    /** Allows a failed deregistration to be retried while the token remains live. */
    function retryableStop(): void {
      if (!group.stopping) group.cleanup = null
    }
  )
  return waitForContext(ctx, group.cleanup)
}

/** Registers one complete ServiceInstance and retains its provider-private owner. */
async function registerService(
  state: ProviderState,
  ctx: Context,
  value: ServiceInstance
): Promise<RegistrationGroup> {
  checkContext(ctx)
  const service = snapshotServiceInstance(value)
  const ttlSeconds = Math.ceil(state.provider.ttlMs / 1_000)
  const records = await instanceRecords(
    service,
    state.provider.domain,
    ttlSeconds,
    state.provider.maxDecodedPayloadBytes
  )
  boundedResponsePackets(records, state.provider.maxPacketBytes)
  const goodbye = await instanceRecords(
    service,
    state.provider.domain,
    0,
    state.provider.maxDecodedPayloadBytes
  )
  const candidate: TokenRecord = {
    token: Object.freeze({}),
    service,
    records,
    goodbye,
    identity: identityPreimage(service),
    active: false
  }
  const candidates: readonly TokenRecord[] = Object.freeze([candidate])
  const selected = await selectedInterfaces(ctx, state.host, state.provider)
  const available = new Set<string>()
  for (const networkInterface of selected)
    available.add(JSON.stringify([networkInterface.family, networkInterface.address]))
  for (const address of parseInstanceAddresses(service)) {
    if (!available.has(JSON.stringify([address.family, address.address]))) {
      throw newUnsupportedRegistryCapabilityError(
        "mdns-endpoint-address",
        `${address.address} does not belong to a selected local interface`
      )
    }
  }
  const resources = await bindResources(ctx, state.host, state.provider, selected)
  const terminal = deferred<void>()
  void terminal.promise.catch(observeTerminal)
  const [owner, cancelOwner] = withCancelCause(background())
  const group: RegistrationGroup = {
    tokens: Object.freeze(candidates),
    resources,
    terminal,
    owner,
    cancelOwner,
    ttlMs: state.provider.ttlMs,
    refreshTimer: null,
    stopping: false,
    quiescing: false,
    cleanup: null,
    failed: null
  }
  const admissionRollbackFailures: Error[] = []
  try {
    await exclusive(
      state,
      ctx,
      /** Probes, announces, and commits every sorted registration token atomically. */
      async function acceptTokens(): Promise<void> {
        const accepted: TokenRecord[] = []
        try {
          for (const candidate of candidates) {
            await probe(state, ctx, resources, candidate)
            const stack = state.stacks.get(candidate.identity) ?? []
            stack.push(candidate)
            state.stacks.set(candidate.identity, stack)
            candidate.active = true
            accepted.push(candidate)
            await sendRecordSets(ctx, resources, [candidate.records], state.provider)
          }
        } catch (error) {
          const rolledBack = new Set<TokenRecord>()
          for (const candidate of accepted.slice().reverse()) {
            const stack = state.stacks.get(candidate.identity)
            rolledBack.add(candidate)
            removeToken(state.stacks, candidate)
            const restored = currentToken(stack)
            try {
              await sendRecordSets(
                background(),
                resources,
                [
                  restored === null
                    ? goodbyeAfterRemoval(state, candidate, rolledBack)
                    : restored.records
                ],
                state.provider
              )
            } catch (rollbackError) {
              pushUniqueFailure(
                admissionRollbackFailures,
                normalizeBoundaryError("mDNS registration wire rollback", rollbackError)
              )
            }
          }
          throw error
        }
      }
    )
    state.groups.add(group)
    startRegistrationLoops(state, group, owner)
    startRefresh(state, group)
    return group
  } catch (error) {
    const primary = normalizeBoundaryError("mDNS registration admission", error)
    cancelOwner(primary)
    const failures: Error[] = [primary]
    for (const failure of admissionRollbackFailures) pushUniqueFailure(failures, failure)
    for (const failure of await resourceCleanupFailures(resources))
      pushUniqueFailure(failures, failure)
    throw combineFailures(failures, "mDNS registration admission rollback failed")
  }
}

/** Registers or replaces one identity without exposing its network owner. */
function registerInstance(
  state: ProviderState,
  ctx: Context,
  value: ServiceInstance
): Promise<void> {
  const instance = snapshotServiceInstance(value)
  const identity = identityPreimage(instance)
  return exclusiveRegistration(
    state,
    ctx,
    /** Announces the replacement before retiring the previous owner. */
    async function replace(): Promise<void> {
      const previous = state.registrations.get(identity)
      const accepted = await registerService(state, ctx, instance)
      state.registrations.set(identity, accepted)
      if (previous !== undefined && previous !== accepted) {
        await stopAcceptedRegistration(state, previous, ctx)
      }
    }
  )
}

/** Deregisters only the exact currently retained ServiceInstance snapshot. */
function deregisterInstance(
  state: ProviderState,
  ctx: Context,
  value: ServiceInstance
): Promise<void> {
  const instance = snapshotServiceInstance(value)
  const identity = identityPreimage(instance)
  return exclusiveRegistration(
    state,
    ctx,
    /** Sends goodbye and releases every provider-owned resource for this exact instance. */
    async function remove(): Promise<void> {
      const current = state.registrations.get(identity)
      const token = current?.tokens[0]
      if (current === undefined || token === undefined) return
      if (canonicalPayload(token.service) !== canonicalPayload(instance)) return
      await stopAcceptedRegistration(state, current, ctx)
      if (state.registrations.get(identity) === current) state.registrations.delete(identity)
    }
  )
}

/** Runs one bounded multicast query and returns every valid managed ServiceInstance response. */
async function queryServices(
  state: ProviderState,
  ctx: Context,
  questions: readonly DNSQuestion[],
  timeoutMs: number
): Promise<readonly ServiceInstance[]> {
  checkContext(ctx)
  const resources = await bindResources(ctx, state.host, state.provider)
  const cache = newMDNSCache()
  const aliases = newPublisherAliases()
  const wireRecords = newWireRecordAccumulator(state.provider)
  const observedNames = new Set<string>()
  try {
    await sendPacket(ctx, resources, queryPacket(questions), state.provider)
    const collectors: Promise<void>[] = []
    for (const resource of resources) {
      collectors.push(
        collectResponses(
          ctx,
          resource,
          timeoutMs,
          state.provider.maxPacketBytes,
          /** Adds every valid managed answer to this query's isolated logical cache. */
          async function collect(datagram, packet): Promise<void> {
            for (const wire of await wireRecords.observe(datagram, packet)) {
              cache.observe(
                publisherKey(datagram, wire.service, aliases),
                wire.service,
                wire.ttlSeconds,
                performance.now()
              )
              observedNames.add(wire.service.name)
            }
          }
        )
      )
    }
    await Promise.all(collectors)
    const found: ServiceInstance[] = []
    for (const name of observedNames) {
      for (const service of cache.instances(name)) found.push(service)
    }
    return snapshotServiceInstances(found)
  } finally {
    cache.close()
    await closeResources(resources)
  }
}

/** Opens one watcher listener and starts cache/event ownership loops. */
async function openWatcher(state: ProviderState, ctx: Context, name: string): Promise<Watcher> {
  checkContext(ctx)
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("mDNS watch service name must be non-empty")
  }
  const resources = await bindResources(ctx, state.host, state.provider)
  const queue = newSnapshotQueue(state.provider.watchBufferSize)
  const cache = newMDNSCache()
  const aliases = newPublisherAliases()
  const wireRecords = newWireRecordAccumulator(state.provider)
  const [owner, cancelOwner] = withCancelCause(background())
  const terminal = deferred<void>()
  void terminal.promise.catch(observeTerminal)
  const watchOwner: WatchOwner = {
    queue,
    cache,
    resources,
    terminal,
    cancelOwner,
    expiryTimer: null,
    cleanup: null,
    failure: null,
    stopping: false
  }
  /** Publishes the complete replacement snapshot for this exact service name. */
  function publish(changedName: string): void {
    if (changedName !== name) return
    const failure = queue.push(cache.instances(name))
    if (failure !== null) void cleanupWatcher(watchOwner, failure).catch(observeTerminal)
  }

  /** Terminally fails this watcher and starts owner cleanup. */
  function fail(error: Error): void {
    queue.fail(error)
    void cleanupWatcher(watchOwner, error).catch(observeTerminal)
  }

  for (const resource of resources) {
    void resource.socket.settled().then(
      /** Treats an unexpected clean socket terminal as watcher owner loss. */
      function unexpectedClose(): void {
        if (!watchOwner.stopping) fail(new Error("mDNS watcher socket closed unexpectedly"))
      },
      /** Publishes the exact passive socket failure through the watcher terminal. */
      function socketFailure(error: unknown): void {
        if (!watchOwner.stopping) fail(normalizeBoundaryError("mDNS watcher socket", error))
      }
    )
    /** Receives managed announcements until the owner stops or fails. */
    async function receive(): Promise<void> {
      while (owner.err() === null && !watchOwner.stopping) {
        let datagram: MDNSDatagram
        try {
          datagram = await resource.socket.receive(owner)
        } catch (error) {
          if (owner.err() !== null || watchOwner.stopping) return
          fail(normalizeBoundaryError("mDNS watcher receive", error))
          return
        }
        let packet: DNSPacket
        try {
          packet = decodeDNSPacket(datagram.data, state.provider.maxPacketBytes)
        } catch {
          continue
        }
        if (!packet.response) continue
        try {
          for (const wire of await wireRecords.observe(datagram, packet)) {
            const changedNames = cache.observe(
              publisherKey(datagram, wire.service, aliases),
              wire.service,
              wire.ttlSeconds,
              performance.now()
            )
            for (const changedName of changedNames) publish(changedName)
          }
        } catch (error) {
          fail(normalizeBoundaryError("mDNS watcher protocol", error))
          return
        }
      }
    }
    void receive()
  }
  watchOwner.expiryTimer = setInterval(
    /** Publishes positive-TTL expiry and one-second goodbye-grace transitions. */
    function expire(): void {
      if (watchOwner.stopping) return
      for (const changedName of cache.expire(performance.now())) publish(changedName)
    },
    25
  )

  try {
    await sendPacket(
      ctx,
      resources,
      queryPacket([Object.freeze({ name: await serviceOwner(name, state.provider), type: "PTR" })]),
      state.provider
    )
  } catch (error) {
    const failure = normalizeBoundaryError("mDNS watcher initial query", error)
    queue.fail(failure)
    await cleanupWatcher(watchOwner, failure).catch(observeTerminal)
    throw failure
  }

  return Object.freeze({
    /** Waits for one complete ServiceInstance snapshot under a caller Context. */
    next(nextContext: Context): Promise<readonly ServiceInstance[]> {
      return queue.next(nextContext)
    },
    /** Stops the watcher and waits for owner cleanup. */
    stop(stopContext: Context): Promise<void> {
      queue.stop()
      return waitForContext(stopContext, cleanupWatcher(watchOwner, null))
    }
  })
}

/** Cleans one watcher network owner once while retaining its terminal queue identity. */
function cleanupWatcher(owner: WatchOwner, failure: Error | null): Promise<void> {
  if (failure !== null && owner.failure === null) owner.failure = failure
  if (owner.cleanup !== null) return owner.cleanup
  owner.stopping = true
  if (owner.expiryTimer !== null) {
    clearInterval(owner.expiryTimer)
    owner.expiryTimer = null
  }
  owner.cancelOwner(failure ?? new Error("mDNS watcher stopped"))
  owner.cache.close()
  /** Completes physical cleanup before publishing the stable watcher owner terminal. */
  async function finish(): Promise<void> {
    let cleanupFailure: Error | null = null
    try {
      await closeResources(owner.resources)
    } catch (error) {
      cleanupFailure = normalizeBoundaryError("mDNS watcher cleanup", error)
    }
    try {
      await owner.queue.settled()
    } catch {
      // The logical queue failure is already retained as owner.failure.
    }
    const terminalFailures: Error[] = []
    if (owner.failure !== null) pushUniqueFailure(terminalFailures, owner.failure)
    if (cleanupFailure !== null) pushUniqueFailure(terminalFailures, cleanupFailure)
    if (terminalFailures.length === 0) owner.terminal.resolve(undefined)
    else owner.terminal.reject(combineFailures(terminalFailures, "mDNS watcher terminal failed"))
    if (cleanupFailure !== null) throw cleanupFailure
  }
  owner.cleanup = finish()
  void owner.cleanup.catch(observeTerminal)
  return owner.cleanup
}

/** Creates the unified portable mDNS Registry around one borrowed runtime host. */
export function newMDNSRegistry(
  host: MDNSHost,
  ...options: readonly MDNSOption[] /* likego-typed-rest: preserves Go-style functional options. */
): MDNSRegistry {
  if (
    typeof host !== "object" ||
    host === null ||
    typeof host.networkInterfaces !== "function" ||
    typeof host.bindDatagram !== "function"
  )
    throw new TypeError("MDNSHost must implement networkInterfaces and bindDatagram")
  const provider = mdnsOptions(
    ...options /* likego-typed-spread: forwards the exact ordered provider options. */
  )
  const state: ProviderState = {
    host,
    provider,
    stacks: new Map(),
    groups: new Set(),
    registrations: new Map(),
    mutation: Promise.resolve(),
    registrationMutation: Promise.resolve()
  }

  return Object.freeze({
    /** Registers or replaces one complete ServiceInstance. */
    register(ctx: Context, service: ServiceInstance): Promise<void> {
      return registerInstance(state, ctx, service)
    },
    /** Deregisters the exact currently retained ServiceInstance. */
    deregister(ctx: Context, service: ServiceInstance): Promise<void> {
      return deregisterInstance(state, ctx, service)
    },
    /** Queries all managed identities for one exact service name. */
    async getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
      if (typeof name !== "string" || name.length === 0)
        throw new TypeError("mDNS service name must be non-empty")
      const services = await queryServices(
        state,
        ctx,
        [Object.freeze({ name: await serviceOwner(name, state.provider), type: "PTR" })],
        state.provider.queryTimeoutMs
      )
      return snapshotServiceInstances(
        services.filter(
          /** Retains only the requested original service name. */
          function matching(service): boolean {
            return service.name === name
          }
        )
      )
    },
    /** Opens one complete replacement-snapshot watcher for an exact service name. */
    watch(ctx: Context, name: string): Promise<Watcher> {
      return openWatcher(state, ctx, name)
    }
  })
}
