import { readFile } from "node:fs/promises"

import { decodeDNSPacket, type DNSPacket, type DNSRecord } from "../../src/dns"

/** Describes the packet evidence extracted from one real pcap file. */
export interface MDNSPacketCaptureEvidence {
  readonly valid: boolean
  readonly linkType: number
  readonly frameCount: number
  readonly responsePacketCount: number
  readonly ipv4ResponseCount: number
  readonly ipv6ResponseCount: number
  readonly sourceAddresses: readonly string[]
  readonly ipTTLValues: readonly number[]
  readonly recordTTLValues: readonly number[]
  readonly positiveTTL120: boolean
  readonly goodbyeTTL0: boolean
  readonly positiveCacheFlush: boolean
  readonly goodbyeCacheFlush: boolean
  readonly managedTXT: boolean
  readonly canonicalOwner: boolean
  readonly canonicalTarget: boolean
  readonly legacyNamespaceAbsent: boolean
  readonly owners: readonly string[]
  readonly targets: readonly string[]
  readonly recordTypeCounts: Readonly<Record<"ipv4" | "ipv6", RecordTypeCounts>>
  readonly cacheFlushCounts: Readonly<Record<"ipv4" | "ipv6", CacheFlushCounts>>
  readonly completeGraphs: Readonly<Record<"ipv4" | "ipv6", CompleteGraphEvidence>>
}

export interface RecordTypeCounts {
  readonly PTR: number
  readonly SRV: number
  readonly TXT: number
  readonly A: number
  readonly AAAA: number
}

export interface CacheFlushCounts {
  readonly shared: number
  readonly unique: number
  readonly invalid: number
}

export interface CompleteGraphEvidence {
  readonly positiveTTL120: boolean
  readonly goodbyeTTL0: boolean
}

interface CaptureHeader {
  readonly littleEndian: boolean
  readonly linkType: number
}

interface MDNSFrame {
  readonly family: "ipv4" | "ipv6"
  readonly hopLimit: number
  readonly sourceAddress: string
  readonly payload: Uint8Array
}

/** Reads one unsigned 16-bit integer from packet bytes. */
function readU16(data: Uint8Array, offset: number, littleEndian: boolean): number {
  const first = data[offset]
  const second = data[offset + 1]
  if (first === undefined || second === undefined) throw new TypeError("pcap packet is truncated")
  return littleEndian ? first | (second << 8) : (first << 8) | second
}

/** Reads one unsigned 32-bit integer from packet bytes. */
function readU32(data: Uint8Array, offset: number, littleEndian: boolean): number {
  const first = data[offset]
  const second = data[offset + 1]
  const third = data[offset + 2]
  const fourth = data[offset + 3]
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    throw new TypeError("pcap packet is truncated")
  }
  if (littleEndian) return first + second * 256 + third * 65_536 + fourth * 16_777_216
  return first * 16_777_216 + second * 65_536 + third * 256 + fourth
}

/** Parses and validates one classic pcap file header. */
function captureHeader(data: Uint8Array): CaptureHeader {
  if (data.byteLength < 24) throw new TypeError("pcap global header is truncated")
  const magic = Array.from(data.slice(0, 4)).join(",")
  const littleEndian = magic === "212,195,178,161" || magic === "77,60,178,161"
  const bigEndian = magic === "161,178,195,212" || magic === "161,178,60,77"
  if (!littleEndian && !bigEndian) throw new TypeError("pcap magic is unsupported")
  if (readU16(data, 4, littleEndian) !== 2 || readU16(data, 6, littleEndian) !== 4) {
    throw new TypeError("pcap version is unsupported")
  }
  const linkType = readU32(data, 20, littleEndian)
  if (linkType !== 1) throw new TypeError("pcap link type must be Ethernet")
  return Object.freeze({ littleEndian, linkType })
}

/** Extracts every complete Ethernet frame from one classic pcap capture. */
function captureFrames(data: Uint8Array, header: CaptureHeader): readonly Uint8Array[] {
  const frames: Uint8Array[] = []
  let offset = 24
  while (offset < data.byteLength) {
    if (offset + 16 > data.byteLength) throw new TypeError("pcap record header is truncated")
    const capturedLength = readU32(data, offset + 8, header.littleEndian)
    const originalLength = readU32(data, offset + 12, header.littleEndian)
    if (capturedLength > originalLength)
      throw new TypeError("pcap captured length exceeds original length")
    const start = offset + 16
    const end = start + capturedLength
    if (end > data.byteLength) throw new TypeError("pcap frame is truncated")
    frames.push(data.slice(start, end))
    offset = end
  }
  return Object.freeze(frames)
}

/** Reports whether an Ethernet destination is the IPv4 mDNS multicast group. */
function ipv4MulticastDestination(data: Uint8Array, offset: number): boolean {
  return (
    data[offset] === 224 &&
    data[offset + 1] === 0 &&
    data[offset + 2] === 0 &&
    data[offset + 3] === 251
  )
}

/** Reports whether an Ethernet destination is the IPv6 link-local mDNS multicast group. */
function ipv6MulticastDestination(data: Uint8Array, offset: number): boolean {
  if (data[offset] !== 0xff || data[offset + 1] !== 2 || data[offset + 15] !== 0xfb) return false
  for (let index = 2; index < 15; index += 1) {
    if (data[offset + index] !== 0) return false
  }
  return true
}

/** Formats one packet IPv4 source address without runtime-specific networking helpers. */
function ipv4SourceAddress(data: Uint8Array, offset: number): string {
  return `${data[offset] ?? 0}.${data[offset + 1] ?? 0}.${data[offset + 2] ?? 0}.${data[offset + 3] ?? 0}`
}

/** Formats one packet IPv6 source address as eight lowercase hexadecimal groups. */
function ipv6SourceAddress(data: Uint8Array, offset: number): string {
  const groups: string[] = []
  for (let index = 0; index < 16; index += 2) {
    groups.push(readU16(data, offset + index, false).toString(16))
  }
  return groups.join(":")
}

/** Extracts one valid multicast UDP/5353 payload from an IPv4 frame. */
function ipv4Frame(data: Uint8Array, offset: number): MDNSFrame | null {
  if (offset + 20 > data.byteLength || (data[offset] ?? 0) >>> 4 !== 4) return null
  const headerBytes = ((data[offset] ?? 0) & 15) * 4
  if (headerBytes < 20 || offset + headerBytes + 8 > data.byteLength) return null
  const totalLength = readU16(data, offset + 2, false)
  if (totalLength < headerBytes + 8 || offset + totalLength > data.byteLength) return null
  if (data[offset + 9] !== 17 || !ipv4MulticastDestination(data, offset + 16)) return null
  if ((readU16(data, offset + 6, false) & 0x3fff) !== 0) return null
  const udp = offset + headerBytes
  if (readU16(data, udp, false) !== 5_353 || readU16(data, udp + 2, false) !== 5_353) return null
  const udpLength = readU16(data, udp + 4, false)
  if (udpLength < 8 || udp + udpLength > offset + totalLength) return null
  return Object.freeze({
    family: "ipv4",
    hopLimit: data[offset + 8] ?? 0,
    sourceAddress: ipv4SourceAddress(data, offset + 12),
    payload: data.slice(udp + 8, udp + udpLength)
  })
}

/** Extracts one valid multicast UDP/5353 payload from an IPv6 frame. */
function ipv6Frame(data: Uint8Array, offset: number): MDNSFrame | null {
  if (offset + 48 > data.byteLength || (data[offset] ?? 0) >>> 4 !== 6) return null
  const payloadLength = readU16(data, offset + 4, false)
  if (offset + 40 + payloadLength > data.byteLength || data[offset + 6] !== 17) return null
  if (!ipv6MulticastDestination(data, offset + 24)) return null
  const udp = offset + 40
  if (readU16(data, udp, false) !== 5_353 || readU16(data, udp + 2, false) !== 5_353) return null
  const udpLength = readU16(data, udp + 4, false)
  if (udpLength < 8 || udpLength > payloadLength || udp + udpLength > data.byteLength) return null
  return Object.freeze({
    family: "ipv6",
    hopLimit: data[offset + 7] ?? 0,
    sourceAddress: ipv6SourceAddress(data, offset + 8),
    payload: data.slice(udp + 8, udp + udpLength)
  })
}

/** Extracts one multicast mDNS datagram from Ethernet, including one optional VLAN header. */
function mdnsFrame(data: Uint8Array): MDNSFrame | null {
  if (data.byteLength < 14) return null
  let etherType = readU16(data, 12, false)
  let offset = 14
  if (etherType === 0x8100 || etherType === 0x88a8) {
    if (data.byteLength < 18) return null
    etherType = readU16(data, 16, false)
    offset = 18
  }
  if (etherType === 0x0800) return ipv4Frame(data, offset)
  if (etherType === 0x86dd) return ipv6Frame(data, offset)
  return null
}

/** Copies every DNS resource record into one flat list. */
function records(packet: DNSPacket): readonly DNSRecord[] {
  const output: DNSRecord[] = []
  for (const record of packet.answers) output.push(record)
  for (const record of packet.authorities) output.push(record)
  for (const record of packet.additionals) output.push(record)
  return Object.freeze(output)
}

/** Inserts one value into a sorted unique numeric evidence list. */
function numericEvidence(values: Set<number>): readonly number[] {
  return Object.freeze(
    Array.from(values).sort(function ascending(left, right): number {
      return left - right
    })
  )
}

/** Inserts one value into a sorted unique string evidence list. */
function stringEvidence(values: Set<string>): readonly string[] {
  return Object.freeze(Array.from(values).sort())
}

/** Reports whether one RR owner is a canonical go-like identity FQDN. */
function canonicalIdentityOwner(value: string): boolean {
  return /^li-[a-z2-7]+\.ls-[a-z2-7]+\.(?:[a-z0-9_-]+\.)*go-like\.$/.test(value)
}

/** Reports whether one RR owner is a canonical go-like service FQDN. */
function canonicalServiceOwner(value: string): boolean {
  return /^ls-[a-z2-7]+\.(?:[a-z0-9_-]+\.)*go-like\.$/.test(value)
}

/** Reports whether one RR owner is a canonical go-like host FQDN. */
function canonicalHostOwner(value: string): boolean {
  return /^lh-[a-z2-7]+\.(?:[a-z0-9_-]+\.)*go-like\.$/.test(value)
}

/** Reports whether one SRV target is a canonical go-like host FQDN. */
function canonicalHostTarget(value: string): boolean {
  return /^lh-[a-z2-7]+\.(?:[a-z0-9_-]+\.)*go-like\.$/.test(value)
}

/** Reads one structural SRV target from a decoded record payload. */
function srvTarget(value: DNSRecord["data"]): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("target" in value))
    return null
  return typeof value.target === "string" ? value.target : null
}

/** Reports whether one TXT payload contains an exact marker or marker prefix. */
function txtContains(record: DNSRecord, value: string, prefix = false): boolean {
  if (record.type !== "TXT" || !Array.isArray(record.data)) return false
  const decoder = new TextDecoder("utf-8", { fatal: false })
  for (const item of record.data) {
    const decoded = decoder.decode(item)
    if (prefix ? decoded.startsWith(value) : decoded === value) return true
  }
  return false
}

/** Returns the required cache-flush class for one canonical go-like graph record. */
function expectedFlush(record: DNSRecord): boolean | null {
  if (record.type === "PTR" && record.name.endsWith(".go-like.")) return false
  if (record.type === "TXT" && canonicalServiceOwner(record.name)) return false
  if (record.type === "SRV" && canonicalIdentityOwner(record.name)) return true
  if (
    record.type === "TXT" &&
    canonicalIdentityOwner(record.name) &&
    txtContains(record, "Go-Like-Wire-Version=2")
  ) {
    return true
  }
  if ((record.type === "A" || record.type === "AAAA") && canonicalHostOwner(record.name))
    return true
  return null
}

/** Reports whether one family/TTL record set contains a fully linked canonical go-like graph. */
function completeGraph(
  values: readonly DNSRecord[],
  family: "ipv4" | "ipv6",
  ttl: number
): boolean {
  const addressType = family === "ipv4" ? "A" : "AAAA"
  for (const identityTXT of values) {
    if (
      identityTXT.ttl !== ttl ||
      identityTXT.type !== "TXT" ||
      !identityTXT.flush ||
      !canonicalIdentityOwner(identityTXT.name) ||
      !txtContains(identityTXT, "Go-Like-Wire-Version=2")
    )
      continue
    const instanceOwner = identityTXT.name
    const servicePointer = values.find(
      /** Selects the shared service PTR linked to this exact instance. */
      function pointer(record): boolean {
        return (
          record.ttl === ttl &&
          record.type === "PTR" &&
          !record.flush &&
          canonicalServiceOwner(record.name) &&
          record.data === instanceOwner &&
          instanceOwner.endsWith(`.${record.name}`)
        )
      }
    )
    if (servicePointer === undefined) continue
    const serviceOwner = servicePointer.name
    const serviceName = values.some(
      /** Requires the shared human-readable service-name TXT. */
      function name(record): boolean {
        return (
          record.ttl === ttl &&
          record.name === serviceOwner &&
          record.type === "TXT" &&
          !record.flush &&
          txtContains(record, "Go-Like-Service-Name=", true)
        )
      }
    )
    if (!serviceName) continue
    const domain = serviceOwner.slice(serviceOwner.indexOf(".") + 1)
    const listed = values.some(
      /** Requires the fixed list-owner PTR to this exact service owner. */
      function list(record): boolean {
        return (
          record.ttl === ttl &&
          record.name === `_services.${domain}` &&
          record.type === "PTR" &&
          !record.flush &&
          record.data === serviceOwner
        )
      }
    )
    if (!listed) continue
    const serviceRecord = values.find(
      /** Requires the unique SRV for this exact instance. */
      function service(record): boolean {
        return (
          record.ttl === ttl &&
          record.name === instanceOwner &&
          record.type === "SRV" &&
          record.flush
        )
      }
    )
    if (serviceRecord === undefined) continue
    const hostOwner = srvTarget(serviceRecord.data)
    if (hostOwner === null || !canonicalHostOwner(hostOwner)) continue
    const addressed = values.some(
      /** Requires an address of the captured family at the exact SRV target. */
      function address(record): boolean {
        return (
          record.ttl === ttl &&
          record.name === hostOwner &&
          record.type === addressType &&
          record.flush
        )
      }
    )
    if (addressed) return true
  }
  return false
}

/** Creates mutable per-family counters used only during one capture inspection. */
function recordTypeCounts(): Record<"PTR" | "SRV" | "TXT" | "A" | "AAAA", number> {
  return { PTR: 0, SRV: 0, TXT: 0, A: 0, AAAA: 0 }
}

/** Freezes one exact record-type count snapshot. */
function freezeRecordTypeCounts(
  value: Record<"PTR" | "SRV" | "TXT" | "A" | "AAAA", number>
): RecordTypeCounts {
  return Object.freeze({
    PTR: value.PTR,
    SRV: value.SRV,
    TXT: value.TXT,
    A: value.A,
    AAAA: value.AAAA
  })
}

/** Parses one real packet capture into release evidence. */
export async function inspectPacketCapture(path: string): Promise<MDNSPacketCaptureEvidence> {
  const data = await readFile(path)
  const header = captureHeader(data)
  const frames = captureFrames(data, header)
  const ipTTLs = new Set<number>()
  const recordTTLs = new Set<number>()
  const sourceAddresses = new Set<string>()
  const owners = new Set<string>()
  const targets = new Set<string>()
  let responsePacketCount = 0
  let ipv4ResponseCount = 0
  let ipv6ResponseCount = 0
  let positiveTTL120 = false
  let goodbyeTTL0 = false
  let positiveCacheFlush = false
  let goodbyeCacheFlush = false
  let managedTXT = false
  let canonicalOwner = false
  let canonicalTarget = false
  let legacyNamespaceAbsent = true
  const familyRecords: Record<"ipv4" | "ipv6", DNSRecord[]> = { ipv4: [], ipv6: [] }
  const familyTypeCounts = { ipv4: recordTypeCounts(), ipv6: recordTypeCounts() }
  const familyFlushCounts: Record<
    "ipv4" | "ipv6",
    { shared: number; unique: number; invalid: number }
  > = {
    ipv4: { shared: 0, unique: 0, invalid: 0 },
    ipv6: { shared: 0, unique: 0, invalid: 0 }
  }
  const decoder = new TextDecoder("utf-8", { fatal: false })
  for (const frame of frames) {
    const datagram = mdnsFrame(frame)
    if (datagram === null) continue
    if (decoder.decode(datagram.payload).includes("Micro-")) legacyNamespaceAbsent = false
    let packet: DNSPacket
    try {
      packet = decodeDNSPacket(datagram.payload, 1_200)
    } catch {
      continue
    }
    if (!packet.response) continue
    responsePacketCount += 1
    sourceAddresses.add(datagram.sourceAddress)
    if (datagram.family === "ipv4") ipv4ResponseCount += 1
    else ipv6ResponseCount += 1
    ipTTLs.add(datagram.hopLimit)
    for (const record of records(packet)) {
      familyRecords[datagram.family].push(record)
      familyTypeCounts[datagram.family][record.type] += 1
      const flush = expectedFlush(record)
      if (flush !== null) {
        if (flush !== record.flush) familyFlushCounts[datagram.family].invalid += 1
        else if (flush) familyFlushCounts[datagram.family].unique += 1
        else familyFlushCounts[datagram.family].shared += 1
      }
      owners.add(record.name)
      recordTTLs.add(record.ttl)
      if (record.ttl === 120) positiveTTL120 = true
      if (record.ttl === 0) goodbyeTTL0 = true
      if (record.ttl === 120 && record.flush) positiveCacheFlush = true
      if (record.ttl === 0 && record.flush) goodbyeCacheFlush = true
      if (canonicalIdentityOwner(record.name)) canonicalOwner = true
      if (record.type === "PTR" && typeof record.data === "string") targets.add(record.data)
      if (record.type === "SRV") {
        const target = srvTarget(record.data)
        if (target === null) continue
        targets.add(target)
        if (canonicalHostTarget(target)) canonicalTarget = true
      }
      if (record.type !== "TXT" || !Array.isArray(record.data)) continue
      for (const item of record.data) {
        const value = decoder.decode(item)
        if (value === "Go-Like-Wire-Version=2") managedTXT = true
        if (value.startsWith("Micro-")) legacyNamespaceAbsent = false
      }
    }
  }
  const ipTTLValues = numericEvidence(ipTTLs)
  const recordTTLValues = numericEvidence(recordTTLs)
  const completeGraphs = Object.freeze({
    ipv4: Object.freeze({
      positiveTTL120: completeGraph(familyRecords.ipv4, "ipv4", 120),
      goodbyeTTL0: completeGraph(familyRecords.ipv4, "ipv4", 0)
    }),
    ipv6: Object.freeze({
      positiveTTL120: completeGraph(familyRecords.ipv6, "ipv6", 120),
      goodbyeTTL0: completeGraph(familyRecords.ipv6, "ipv6", 0)
    })
  })
  const ipv4GraphsValid =
    ipv4ResponseCount === 0 ||
    (completeGraphs.ipv4.positiveTTL120 && completeGraphs.ipv4.goodbyeTTL0)
  const ipv6GraphsValid =
    ipv6ResponseCount === 0 ||
    (completeGraphs.ipv6.positiveTTL120 && completeGraphs.ipv6.goodbyeTTL0)
  const classificationValid =
    familyFlushCounts.ipv4.invalid === 0 && familyFlushCounts.ipv6.invalid === 0
  const valid =
    responsePacketCount > 0 &&
    ipTTLValues.length === 1 &&
    ipTTLValues[0] === 255 &&
    positiveTTL120 &&
    goodbyeTTL0 &&
    positiveCacheFlush &&
    goodbyeCacheFlush &&
    managedTXT &&
    canonicalOwner &&
    canonicalTarget &&
    legacyNamespaceAbsent &&
    classificationValid &&
    ipv4GraphsValid &&
    ipv6GraphsValid
  return Object.freeze({
    valid,
    linkType: header.linkType,
    frameCount: frames.length,
    responsePacketCount,
    ipv4ResponseCount,
    ipv6ResponseCount,
    sourceAddresses: stringEvidence(sourceAddresses),
    ipTTLValues,
    recordTTLValues,
    positiveTTL120,
    goodbyeTTL0,
    positiveCacheFlush,
    goodbyeCacheFlush,
    managedTXT,
    canonicalOwner,
    canonicalTarget,
    legacyNamespaceAbsent,
    owners: stringEvidence(owners),
    targets: stringEvidence(targets),
    recordTypeCounts: Object.freeze({
      ipv4: freezeRecordTypeCounts(familyTypeCounts.ipv4),
      ipv6: freezeRecordTypeCounts(familyTypeCounts.ipv6)
    }),
    cacheFlushCounts: Object.freeze({
      ipv4: Object.freeze({
        shared: familyFlushCounts.ipv4.shared,
        unique: familyFlushCounts.ipv4.unique,
        invalid: familyFlushCounts.ipv4.invalid
      }),
      ipv6: Object.freeze({
        shared: familyFlushCounts.ipv6.shared,
        unique: familyFlushCounts.ipv6.unique,
        invalid: familyFlushCounts.ipv6.invalid
      })
    }),
    completeGraphs
  })
}
