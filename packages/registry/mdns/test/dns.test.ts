import { describe, expect, test } from "bun:test"

import { decodeDNSPacket, encodeDNSPacket, validateDNSName, type DNSPacket } from "../src/dns"

const encoder = new TextEncoder()

describe("portable DNS wire codec", () => {
  test("validates 63-byte labels and the complete 255-byte encoded name", () => {
    expect(validateDNSName(["A".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)])).toBe(
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.`
    )
    expect(() => validateDNSName(["a".repeat(64)])).toThrow(RangeError)
    expect(() =>
      validateDNSName(["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)])
    ).toThrow(RangeError)
    expect(() => validateDNSName(["é"])).toThrow(TypeError)
  })

  test("encodes one fixed PTR query vector", () => {
    const packet: DNSPacket = {
      id: 0,
      response: false,
      questions: [{ name: "_services.go-like.", type: "PTR" }],
      answers: [],
      authorities: [],
      additionals: []
    }
    expect(Buffer.from(encodeDNSPacket(packet, 1_200)).toString("hex")).toBe(
      "000000000001000000000000095f736572766963657307676f2d6c696b6500000c0001"
    )
  })

  test("round-trips the DNS ANY question used by mDNS responders", () => {
    const wire = Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 97, 0, 0, 255, 0, 1])
    const decoded = decodeDNSPacket(wire, 512)
    expect(decoded.questions).toEqual([{ name: "a.", type: "ANY" }])
    expect(encodeDNSPacket(decoded, 512)).toEqual(wire)
  })

  test("round-trips supported records and preserves shared versus unique cache-flush", () => {
    const packet: DNSPacket = {
      id: 27,
      response: true,
      questions: [],
      answers: [
        { name: "_services.go-like.", type: "PTR", ttl: 120, flush: false, data: "ls-a.go-like." },
        {
          name: "li-a.ls-a.go-like.",
          type: "SRV",
          ttl: 120,
          flush: true,
          data: { priority: 0, weight: 0, port: 8080, target: "lh-a.go-like." }
        },
        {
          name: "li-a.ls-a.go-like.",
          type: "TXT",
          ttl: 120,
          flush: true,
          data: [
            encoder.encode("Go-Like-Wire-Version=1"),
            encoder.encode("Go-Like-Chunk-Count=000")
          ]
        },
        { name: "lh-a.go-like.", type: "A", ttl: 120, flush: true, data: "127.0.0.1" },
        { name: "lh-a.go-like.", type: "AAAA", ttl: 120, flush: true, data: "2001:db8::1" }
      ],
      authorities: [],
      additionals: []
    }
    const decoded = decodeDNSPacket(encodeDNSPacket(packet, 1_200), 1_200)
    expect(decoded).toEqual(packet)
    expect(decoded.answers.map((record) => record.flush)).toEqual([false, true, true, true, true])
  })

  test("ignores unsupported resource records without discarding supported answers", () => {
    const supported = encodeDNSPacket(
      {
        id: 0,
        response: true,
        questions: [],
        answers: [
          { name: "_services.go-like.", type: "PTR", ttl: 120, flush: false, data: "ls-a.go-like." }
        ],
        authorities: [],
        additionals: []
      },
      512
    )
    const packet = new Uint8Array(supported.byteLength + 11)
    packet.set(supported)
    packet[11] = 1
    packet.set(
      [0x00, 0x00, 0x29, 0x04, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      supported.byteLength
    )

    const decoded = decodeDNSPacket(packet, 512)
    expect(decoded.answers).toHaveLength(1)
    expect(decoded.answers[0]?.type).toBe("PTR")
    expect(decoded.additionals).toEqual([])
  })

  test("normalizes the RFC 2181 high TTL bit on input and rejects it on output", () => {
    const maximum: DNSPacket = {
      id: 0,
      response: true,
      questions: [],
      answers: [
        { name: "x.go-like.", type: "A", ttl: 2_147_483_647, flush: true, data: "127.0.0.1" }
      ],
      authorities: [],
      additionals: []
    }
    expect(decodeDNSPacket(encodeDNSPacket(maximum, 512), 512).answers[0]?.ttl).toBe(2_147_483_647)
    expect(() =>
      encodeDNSPacket(
        {
          id: 0,
          response: true,
          questions: [],
          answers: [
            { name: "x.go-like.", type: "A", ttl: 2_147_483_648, flush: true, data: "127.0.0.1" }
          ],
          authorities: [],
          additionals: []
        },
        512
      )
    ).toThrow(RangeError)

    const high = Uint8Array.from([
      0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 120, 0, 0, 1, 0x80, 1, 0x80, 0, 0, 0, 0, 4, 127, 0,
      0, 1
    ])
    expect(decodeDNSPacket(high, 512).answers[0]?.ttl).toBe(0)
    high.set([0xff, 0xff, 0xff, 0xff], 19)
    expect(decodeDNSPacket(high, 512).answers[0]?.ttl).toBe(0)
  })

  test("rejects oversized TXT items, malformed packets, and configured packet overflow", () => {
    const oversized: DNSPacket = {
      id: 0,
      response: true,
      questions: [],
      answers: [
        {
          name: "x.go-like.",
          type: "TXT",
          ttl: 1,
          flush: true,
          data: [new Uint8Array(256)]
        }
      ],
      authorities: [],
      additionals: []
    }
    expect(() => encodeDNSPacket(oversized, 1_200)).toThrow(RangeError)
    expect(() =>
      encodeDNSPacket(
        {
          id: 0,
          response: true,
          questions: [],
          answers: [
            {
              name: "x.go-like.",
              type: "TXT",
              ttl: 1,
              flush: true,
              data: Array.from({ length: 5 }, () => new Uint8Array(255))
            }
          ],
          authorities: [],
          additionals: []
        },
        1_200
      )
    ).toThrow(RangeError)
    expect(() => decodeDNSPacket(new Uint8Array([0, 1, 2]), 1_200)).toThrow()
    expect(() => decodeDNSPacket(new Uint8Array(1_201), 1_200)).toThrow(RangeError)
  })

  test("covers compressed names, IPv4-tail IPv6, and numeric codec boundaries", () => {
    const compressedQuestion = Uint8Array.from([
      0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 97, 0, 0, 1, 0, 1, 0xc0, 0x0c, 0, 1, 0, 1
    ])
    expect(
      decodeDNSPacket(compressedQuestion, 512).questions.map((question) => question.name)
    ).toEqual(["a.", "a."])
    const pointerCycle = Uint8Array.from([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1
    ])
    expect(() => decodeDNSPacket(pointerCycle, 512)).toThrow("pointer is invalid")
    const unsupportedType = Uint8Array.from([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 97, 0, 0, 2, 0, 1
    ])
    expect(() => decodeDNSPacket(unsupportedType, 512)).toThrow("record type 2 is unsupported")

    const ipv4Tail: DNSPacket = {
      id: 65_535,
      response: true,
      questions: [],
      answers: [
        {
          name: "x.go-like.",
          type: "AAAA",
          ttl: 2_147_483_647,
          flush: true,
          data: "::ffff:192.0.2.1"
        }
      ],
      authorities: [],
      additionals: []
    }
    expect(decodeDNSPacket(encodeDNSPacket(ipv4Tail, 512), 512).answers[0]?.data).toBe(
      "::ffff:c000:201"
    )
    for (const address of ["::1", "1::", "2001:db8:0:1:2:3:4:5"]) {
      const packet: DNSPacket = {
        id: 0,
        response: true,
        questions: [],
        answers: [{ name: "x.go-like.", type: "AAAA", ttl: 1, flush: true, data: address }],
        authorities: [],
        additionals: []
      }
      expect(decodeDNSPacket(encodeDNSPacket(packet, 512), 512).answers[0]?.data).toBe(address)
    }
    expect(() => encodeDNSPacket(ipv4Tail, 511)).toThrow(RangeError)
    expect(() => decodeDNSPacket(new Uint8Array(12), 1_201)).toThrow(RangeError)
    expect(() => encodeDNSPacket({ ...ipv4Tail, id: -1 }, 512)).toThrow(RangeError)
    expect(() =>
      encodeDNSPacket(
        {
          ...ipv4Tail,
          answers: [{ name: "x.go-like.", type: "A", ttl: -1, flush: true, data: "127.0.0.1" }]
        },
        512
      )
    ).toThrow(RangeError)
    expect(() =>
      encodeDNSPacket(
        {
          ...ipv4Tail,
          answers: [{ name: "x.go-like.", type: "A", ttl: 1, flush: true, data: "01.2.3.4" }]
        },
        512
      )
    ).toThrow(TypeError)
    expect(() =>
      encodeDNSPacket(
        {
          ...ipv4Tail,
          answers: [{ name: "x.go-like.", type: "AAAA", ttl: 1, flush: true, data: "fe80::1%en0" }]
        },
        512
      )
    ).toThrow(TypeError)
    expect(() =>
      encodeDNSPacket(
        {
          ...ipv4Tail,
          answers: [{ name: "x.go-like.", type: "AAAA", ttl: 1, flush: true, data: "1:2:3" }]
        },
        512
      )
    ).toThrow(TypeError)
  })
})
