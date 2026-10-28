import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { encodeDNSPacket, type DNSPacket, type DNSRecord } from "../src/dns"
import { inspectPacketCapture } from "./e2e/packet-capture"

const InstanceOwner = "li-instance.ls-service.go-like."
const ServiceOwner = "ls-service.go-like."
const ListOwner = "_services.go-like."
const HostOwner = "lh-host.go-like."
const BrokenHostOwner = "lh-other.go-like."

type FixtureMutation =
  | "none"
  | "missing-ptr"
  | "missing-address"
  | "wrong-shared-flush"
  | "broken-target"

/** Creates one complete managed response at an exact DNS RR TTL. */
function response(
  ttl: number,
  family: "ipv4" | "ipv6",
  mutation: FixtureMutation = "none"
): Uint8Array {
  const encoder = new TextEncoder()
  const records: DNSRecord[] = [
    { name: ListOwner, type: "PTR", ttl, flush: false, data: ServiceOwner },
    {
      name: ServiceOwner,
      type: "TXT",
      ttl,
      flush: false,
      data: [encoder.encode("Go-Like-Service-Name=service")]
    },
    {
      name: ServiceOwner,
      type: "PTR",
      ttl,
      flush: mutation === "wrong-shared-flush",
      data: InstanceOwner
    },
    {
      name: InstanceOwner,
      type: "SRV",
      ttl,
      flush: true,
      data: {
        priority: 0,
        weight: 0,
        port: 8_080,
        target: mutation === "broken-target" ? BrokenHostOwner : HostOwner
      }
    },
    {
      name: InstanceOwner,
      type: "TXT",
      ttl,
      flush: true,
      data: [encoder.encode("Go-Like-Wire-Version=2"), encoder.encode("Go-Like-Chunk-Count=001")]
    },
    family === "ipv4"
      ? { name: HostOwner, type: "A", ttl, flush: true, data: "192.0.2.10" }
      : { name: HostOwner, type: "AAAA", ttl, flush: true, data: "fd00::10" }
  ]
  const selected = records.filter(
    /** Applies one deliberate graph omission for negative fixtures. */
    function retained(record): boolean {
      if (mutation === "missing-ptr" && record.type === "PTR") return false
      if (mutation === "missing-address" && (record.type === "A" || record.type === "AAAA"))
        return false
      return true
    }
  )
  const packet: DNSPacket = {
    id: 0,
    response: true,
    questions: [],
    answers: selected,
    authorities: [],
    additionals: []
  }
  return encodeDNSPacket(packet, 1_200)
}

/** Creates one Ethernet/IPv4/UDP frame carrying a multicast DNS payload. */
function ipv4(payload: Uint8Array, ttl: number): Uint8Array {
  const frame = Buffer.alloc(14 + 20 + 8 + payload.byteLength)
  Buffer.from([1, 0, 94, 0, 0, 251, 2, 0, 0, 0, 0, 1]).copy(frame, 0)
  frame.writeUInt16BE(0x0800, 12)
  const ip = 14
  frame[ip] = 0x45
  frame.writeUInt16BE(20 + 8 + payload.byteLength, ip + 2)
  frame[ip + 8] = ttl
  frame[ip + 9] = 17
  Buffer.from([192, 0, 2, 10, 224, 0, 0, 251]).copy(frame, ip + 12)
  const udp = ip + 20
  frame.writeUInt16BE(5_353, udp)
  frame.writeUInt16BE(5_353, udp + 2)
  frame.writeUInt16BE(8 + payload.byteLength, udp + 4)
  Buffer.from(payload).copy(frame, udp + 8)
  return frame
}

/** Creates one Ethernet/IPv6/UDP frame carrying a multicast DNS payload. */
function ipv6(payload: Uint8Array, hopLimit: number): Uint8Array {
  const frame = Buffer.alloc(14 + 40 + 8 + payload.byteLength)
  Buffer.from([51, 51, 0, 0, 0, 251, 2, 0, 0, 0, 0, 2]).copy(frame, 0)
  frame.writeUInt16BE(0x86dd, 12)
  const ip = 14
  frame[ip] = 0x60
  frame.writeUInt16BE(8 + payload.byteLength, ip + 4)
  frame[ip + 6] = 17
  frame[ip + 7] = hopLimit
  Buffer.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]).copy(frame, ip + 8)
  Buffer.from([0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xfb]).copy(frame, ip + 24)
  const udp = ip + 40
  frame.writeUInt16BE(5_353, udp)
  frame.writeUInt16BE(5_353, udp + 2)
  frame.writeUInt16BE(8 + payload.byteLength, udp + 4)
  Buffer.from(payload).copy(frame, udp + 8)
  return frame
}

/** Encodes classic little-endian Ethernet pcap bytes. */
function pcap(frames: readonly Uint8Array[]): Uint8Array {
  let length = 24
  for (const frame of frames) length += 16 + frame.byteLength
  const output = Buffer.alloc(length)
  output.writeUInt32LE(0xa1b2c3d4, 0)
  output.writeUInt16LE(2, 4)
  output.writeUInt16LE(4, 6)
  output.writeUInt32LE(262_144, 16)
  output.writeUInt32LE(1, 20)
  let offset = 24
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    if (frame === undefined) throw new Error("pcap fixture frame disappeared")
    output.writeUInt32LE(index + 1, offset)
    output.writeUInt32LE(0, offset + 4)
    output.writeUInt32LE(frame.byteLength, offset + 8)
    output.writeUInt32LE(frame.byteLength, offset + 12)
    Buffer.from(frame).copy(output, offset + 16)
    offset += 16 + frame.byteLength
  }
  return output
}

test("extracts IP hop, RR TTL, flush, owner, target, and namespace evidence from classic pcap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-mdns-pcap-"))
  const path = join(directory, "mdns.pcap")
  try {
    await writeFile(
      path,
      pcap([
        ipv4(response(120, "ipv4"), 255),
        ipv4(response(0, "ipv4"), 255),
        ipv6(response(120, "ipv6"), 255),
        ipv6(response(0, "ipv6"), 255)
      ])
    )
    const evidence = await inspectPacketCapture(path)
    expect(evidence).toMatchObject({
      valid: true,
      linkType: 1,
      frameCount: 4,
      responsePacketCount: 4,
      ipv4ResponseCount: 2,
      ipv6ResponseCount: 2,
      positiveTTL120: true,
      goodbyeTTL0: true,
      positiveCacheFlush: true,
      goodbyeCacheFlush: true,
      managedTXT: true,
      canonicalOwner: true,
      canonicalTarget: true,
      legacyNamespaceAbsent: true,
      recordTypeCounts: {
        ipv4: { PTR: 4, SRV: 2, TXT: 4, A: 2, AAAA: 0 },
        ipv6: { PTR: 4, SRV: 2, TXT: 4, A: 0, AAAA: 2 }
      },
      cacheFlushCounts: {
        ipv4: { shared: 6, unique: 6, invalid: 0 },
        ipv6: { shared: 6, unique: 6, invalid: 0 }
      },
      completeGraphs: {
        ipv4: { positiveTTL120: true, goodbyeTTL0: true },
        ipv6: { positiveTTL120: true, goodbyeTTL0: true }
      }
    })
    expect(evidence.ipTTLValues).toEqual([255])
    expect(evidence.recordTTLValues).toEqual([0, 120])
    expect(evidence.sourceAddresses).toEqual(["192.0.2.10", "fe80:0:0:0:0:0:0:1"])
    expect(evidence.owners).toContain(InstanceOwner)
    expect(evidence.targets).toContain(HostOwner)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("marks captures with a non-255 multicast hop limit invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-mdns-pcap-hop-"))
  const path = join(directory, "mdns.pcap")
  try {
    await writeFile(path, pcap([ipv4(response(120, "ipv4"), 64), ipv4(response(0, "ipv4"), 64)]))
    expect((await inspectPacketCapture(path)).valid).toBeFalse()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects missing PTR or AAAA, wrong shared flush, and broken owner-target graphs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-mdns-pcap-mutations-"))
  const path = join(directory, "mdns.pcap")
  try {
    const mutations: readonly (readonly [string, readonly Uint8Array[]])[] = [
      [
        "missing PTR",
        [
          ipv4(response(120, "ipv4", "missing-ptr"), 255),
          ipv4(response(0, "ipv4", "missing-ptr"), 255)
        ]
      ],
      [
        "missing AAAA",
        [
          ipv6(response(120, "ipv6", "missing-address"), 255),
          ipv6(response(0, "ipv6", "missing-address"), 255)
        ]
      ],
      [
        "wrong shared flush",
        [
          ipv4(response(120, "ipv4", "wrong-shared-flush"), 255),
          ipv4(response(0, "ipv4", "wrong-shared-flush"), 255)
        ]
      ],
      [
        "broken graph",
        [
          ipv4(response(120, "ipv4", "broken-target"), 255),
          ipv4(response(0, "ipv4", "broken-target"), 255)
        ]
      ]
    ]
    for (const [name, frames] of mutations) {
      await writeFile(path, pcap(frames))
      expect((await inspectPacketCapture(path)).valid, name).toBe(false)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
