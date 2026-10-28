import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import { append, fromServerContext, newMetadata, newServerContext } from "@go-like/metadata"

import { decodeMetadataHeader, encodeMetadataHeader } from "../src/provider"

test("metadata header round-trips ordered multi-values through canonical ASCII", () => {
  const metadata = newMetadata({
    Trace: ["one", "two"],
    tenant: "上海"
  })
  const encoded = encodeMetadataHeader(metadata)

  expect(encoded).not.toBeNull()
  expect(encoded).toMatch(/^v1\.[\x20-\x7e]+$/)
  expect(decodeMetadataHeader(encoded)).toEqual({
    tenant: ["上海"],
    trace: ["one", "two"]
  })
})

test("metadata header omits and restores the canonical empty snapshot", () => {
  expect(encodeMetadataHeader(newMetadata())).toBeNull()
  expect(decodeMetadataHeader(null)).toEqual({})
})

test("metadata header decodes an absent header to one shared immutable empty snapshot", () => {
  const empty = decodeMetadataHeader(null)
  const record = empty as Record<string, unknown>

  expect(empty).toEqual({})
  expect(Object.keys(empty)).toEqual([])
  expect(Object.isFrozen(empty)).toBe(true)
  expect(decodeMetadataHeader(null)).toBe(empty)
  expect(() => {
    record.trace = ["one"]
  }).toThrow(TypeError)
  expect(() => Object.defineProperty(record, "trace", { value: ["one"] })).toThrow(TypeError)

  const attached = fromServerContext(newServerContext(background(), empty))
  expect(attached).toEqual({})
  expect(attached).not.toBe(empty)
  expect(append(empty, "trace", "one")).toEqual({ trace: ["one"] })
  expect(encodeMetadataHeader(empty)).toBeNull()
  expect(Object.keys(decodeMetadataHeader(null))).toEqual([])

  expect(() => decodeMetadataHeader("")).toThrow(
    expect.objectContaining({ name: "TransportProtocolError" })
  )
})

test("metadata header rejects malformed, duplicate, non-canonical, and oversized wires", () => {
  const malformed = [
    "v1.",
    "v2.value",
    `v1.${encodeURIComponent("[]")}`,
    `v1.${encodeURIComponent(JSON.stringify([["trace"]]))}`,
    `v1.${encodeURIComponent(JSON.stringify([["Trace", ["one"]]]))}`,
    `v1.${encodeURIComponent(
      JSON.stringify([
        ["trace", ["one"]],
        ["trace", ["two"]]
      ])
    )}`,
    `v1.${encodeURIComponent(JSON.stringify([["trace", [1]]]))}`,
    `v1.${encodeURIComponent(
      JSON.stringify([
        ["trace", ["one"]],
        ["tenant", ["two"]]
      ])
    )}`,
    `v1.${"x".repeat(16_385)}`
  ]

  for (const value of malformed) {
    expect(() => decodeMetadataHeader(value)).toThrow(
      expect.objectContaining({
        name: "TransportProtocolError",
        code: "GO_LIKE_TRANSPORT_PROTOCOL"
      })
    )
  }
  expect(() => decodeMetadataHeader(undefined as unknown as string)).toThrow(TypeError)
})

test("metadata header enforces the portable encoded-size bound", () => {
  const metadata = newMetadata({ value: "x".repeat(20_000) })
  expect(() => encodeMetadataHeader(metadata)).toThrow(
    "encoded metadata header exceeds 16384 bytes"
  )
})
