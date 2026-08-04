import { describe, expect, test } from "bun:test"

import {
  domain,
  families,
  interfaces,
  maxDecodedPayloadBytes,
  maxPacketBytes,
  mdnsOptions,
  onRegistrationError,
  port,
  queryTimeout,
  ttl,
  watchBufferSize
} from "../src/options"
import type { MDNSOptions } from "../src/types"

describe("mDNS construction options", () => {
  test("normative defaults are immutable", () => {
    const options = mdnsOptions()
    expect(options).toEqual({
      domain: "go-like.",
      interfaceIds: [],
      families: ["ipv4"],
      queryTimeoutMs: 1_000,
      port: 5_353,
      maxPacketBytes: 1_200,
      maxDecodedPayloadBytes: 65_536,
      watchBufferSize: 128,
      ttlMs: 120_000,
      onRegistrationError: null
    })
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.interfaceIds)).toBe(true)
    expect(Object.isFrozen(options.families)).toBe(true)
  })

  test("ordered reducers are last-wins and defensively copied", () => {
    const ids: (string | number)[] = ["en0", 7, "en0"]
    const options = mdnsOptions(
      domain("DEV.Example"),
      domain("mesh.local."),
      interfaces(...ids),
      families("ipv6", "ipv4", "ipv6"),
      queryTimeout(25),
      port(9_999),
      maxPacketBytes(900),
      maxDecodedPayloadBytes(4_096),
      watchBufferSize(64),
      ttl(3_000),
      onRegistrationError(() => {})
    )
    ids.push("late")
    expect(options).toEqual({
      domain: "mesh.local.",
      interfaceIds: ["en0", 7],
      families: ["ipv6", "ipv4"],
      queryTimeoutMs: 25,
      port: 9_999,
      maxPacketBytes: 900,
      maxDecodedPayloadBytes: 4_096,
      watchBufferSize: 64,
      ttlMs: 3_000,
      onRegistrationError: expect.any(Function)
    })
  })

  test("invalid values and malformed reducer output fail during construction", () => {
    expect(() => domain("")).toThrow(TypeError)
    expect(() => domain("-bad.example")).toThrow(TypeError)
    expect(() => domain("bad_.example")).toThrow(TypeError)
    expect(() => interfaces("")).toThrow(TypeError)
    expect(() => interfaces(-1)).toThrow(TypeError)
    expect(() => families()).toThrow(RangeError)
    expect(() => queryTimeout(0)).toThrow(RangeError)
    expect(() => queryTimeout(60_001)).toThrow(RangeError)
    expect(() => port(0)).toThrow(RangeError)
    expect(() => maxPacketBytes(511)).toThrow(RangeError)
    expect(() => maxPacketBytes(1_201)).toThrow(RangeError)
    expect(() => maxDecodedPayloadBytes(1_023)).toThrow(RangeError)
    expect(() => maxDecodedPayloadBytes(65_537)).toThrow(RangeError)
    expect(() => watchBufferSize(0)).toThrow(RangeError)
    expect(() => watchBufferSize(4_097)).toThrow(RangeError)
    expect(() => ttl(1_999)).toThrow(RangeError)
    expect(() => ttl(86_400_001)).toThrow(RangeError)
    expect(() => onRegistrationError(null as never)).toThrow(TypeError)

    /** Returns one structurally typed but semantically invalid candidate. */
    function invalid(_current: MDNSOptions): MDNSOptions {
      return {
        domain: "go-like.",
        interfaceIds: [],
        families: ["ipv4"],
        queryTimeoutMs: 1_000,
        port: 5_353,
        maxPacketBytes: 1_200,
        maxDecodedPayloadBytes: 65_536,
        watchBufferSize: 128,
        ttlMs: 120_000,
        onRegistrationError: 1 as never
      }
    }
    expect(() => mdnsOptions(invalid)).toThrow(TypeError)
  })
})
