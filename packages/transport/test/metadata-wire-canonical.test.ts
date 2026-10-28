import { expect, test } from "bun:test"

import { newMetadata, type Metadata } from "@go-like/metadata"

import { decodeMetadataHeader, encodeMetadataHeader } from "../src/provider"

const MaximumBytes = 16_384
const protocolError = expect.objectContaining({
  name: "TransportProtocolError",
  code: "GO_LIKE_TRANSPORT_PROTOCOL"
})

/** Builds one wire header from raw entries with a chosen percent-encoding. */
function wire(entries: unknown, encode: (text: string) => string = encodeURIComponent): string {
  return `v1.${encode(JSON.stringify(entries))}`
}

/** Encodes a snapshot that must not be empty. */
function encoded(metadata: Metadata): string {
  const value = encodeMetadataHeader(metadata)
  if (value === null) throw new Error("expected a non-empty metadata wire")
  return value
}

test("metadata header round-trips order-sensitive snapshots through their exact canonical wire", () => {
  const ordered = newMetadata({
    "10": "ten",
    "2": ["two", "deux"],
    "1": "one",
    b: "b",
    a: ["a-one", "a-two"]
  })
  const reserved = newMetadata(
    Object.fromEntries([
      ["__proto__", ["proto"]],
      ["constructor", "own"],
      ["toString", []]
    ])
  )
  const unicode = newMetadata({
    猫: "🐈",
    "trace-id": ["%41", "a+b", " ", '"quoted"', "line\nbreak"],
    empty: []
  })

  for (const snapshot of [ordered, reserved, unicode]) {
    const wireValue = encoded(snapshot)
    const decoded = decodeMetadataHeader(wireValue)

    expect(Object.keys(decoded)).toEqual(Object.keys(snapshot))
    expect(Object.getOwnPropertyDescriptors(decoded)).toEqual(
      Object.getOwnPropertyDescriptors(snapshot)
    )
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(encoded(decoded)).toBe(wireValue)
  }
  expect(Object.keys(decodeMetadataHeader(encoded(ordered)))).toEqual(["1", "2", "10", "a", "b"])
})

test("metadata header accepts integer-like keys only in snapshot order", () => {
  const value = ["x"]
  const snapshotOrder = wire([
    ["1", value],
    ["2", value],
    ["10", value],
    ["a", value]
  ])
  const lexicographic = wire([
    ["1", value],
    ["10", value],
    ["2", value],
    ["a", value]
  ])
  const stringsFirst = wire([
    ["a", value],
    ["1", value],
    ["2", value],
    ["10", value]
  ])

  expect(Object.keys(decodeMetadataHeader(snapshotOrder))).toEqual(["1", "2", "10", "a"])
  expect(() => decodeMetadataHeader(lexicographic)).toThrow(protocolError)
  expect(() => decodeMetadataHeader(stringsFirst)).toThrow(protocolError)
})

test("metadata header rejects unsorted, upper-case, duplicate, and invalid keys", () => {
  const one = ["x"]
  const accepted = wire([
    ["alpha", one],
    ["beta", one]
  ])
  expect(decodeMetadataHeader(accepted)).toEqual({ alpha: one, beta: one })

  const invalid: unknown[] = [
    [
      ["beta", one],
      ["alpha", one]
    ],
    [
      ["alpha", one],
      ["Beta", one]
    ],
    [
      ["Alpha", one],
      ["beta", one]
    ],
    [
      ["alpha", one],
      ["alpha", one]
    ],
    [
      ["alpha", one],
      ["alpha", ["y"]]
    ],
    [
      ["alpha", one],
      ["beta", one],
      ["alpha", one]
    ],
    [["İ", one]],
    [["", one]],
    [["\ud800", one]]
  ]
  for (const entries of invalid) {
    expect(() => decodeMetadataHeader(wire(entries))).toThrow(protocolError)
  }
})

test("metadata header rejects every non-canonical spelling of a valid wire", () => {
  const entries = [
    ["tenant", ["a b"]],
    ["trace", ["A", "[x]"]]
  ]
  const canonical = wire(entries)
  expect(decodeMetadataHeader(canonical)).toEqual({ tenant: ["a b"], trace: ["A", "[x]"] })

  const spellings = [
    canonical.replace("A", "%41"),
    canonical.replace("%5B", "%5b"),
    canonical.replace("%20", "+"),
    canonical.replace("%22", '"'),
    canonical.replace("%2C", ","),
    wire(entries, encodeURI),
    wire(entries, (text) =>
      encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase())
    ),
    wire(entries, (text) => encodeURIComponent(JSON.stringify(JSON.parse(text), null, 1))),
    wire(entries, (text) => encodeURIComponent(text.replace("trace", "\\u0074race"))),
    wire(entries, (text) => encodeURIComponent(text.replace('"A"', '"\\u0041"'))),
    `v1.${JSON.stringify(entries)}`,
    `${canonical}%20`,
    `${canonical}%`
  ]

  for (const spelling of spellings) {
    expect(spelling).not.toBe(canonical)
    expect(() => decodeMetadataHeader(spelling)).toThrow(protocolError)
  }
})

test("metadata header rejects malformed entries and ill-formed strings", () => {
  const malformed: unknown[] = [
    [["k", ["\ud800"]]],
    [["k", ["ok", "\udfff"]]],
    [["k", "value"]],
    [["k", [1]]],
    [["k", [null]]],
    [["k", [["nested"]]]],
    [["k", ["v"], "extra"]],
    [{ k: ["v"] }],
    [null],
    "text",
    {},
    []
  ]

  for (const entries of malformed) {
    expect(() => decodeMetadataHeader(wire(entries))).toThrow(protocolError)
  }
})

test("metadata header accepts a canonical wire of exactly 16384 characters and rejects one more", () => {
  const overhead = encoded(newMetadata({ k: "" })).length
  const fill = MaximumBytes - overhead
  const exact = encoded(newMetadata({ k: "x".repeat(fill) }))

  expect(exact).toHaveLength(MaximumBytes)
  expect(decodeMetadataHeader(exact)).toEqual({ k: ["x".repeat(fill)] })
  expect(() => encodeMetadataHeader(newMetadata({ k: "x".repeat(fill + 1) }))).toThrow(
    "encoded metadata header exceeds 16384 bytes"
  )
  expect(() => decodeMetadataHeader(wire([["k", ["x".repeat(fill + 1)]]]))).toThrow(protocolError)
})
