import { describe, expect, test } from "bun:test"

import {
  compareRevision,
  decimal,
  decodeBase64,
  decodeCursor,
  decodeRow,
  encodeBase64,
  encodeCursor,
  encodeRecordPayload,
  encodeText,
  matches,
  maximumKeyBytes,
  maximumPayloadBytes,
  maximumValueBytes,
  pageStart,
  prefixRangeEnd,
  revisionDecimal,
  storeKey
} from "../src/codec"

/** Encodes one JSON value as an unpadded base64url cursor carrier. */
function cursorValue(value: unknown): string {
  return encodeBase64(new TextEncoder().encode(JSON.stringify(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

/** Creates one exact gateway KV around a LikeGo payload. */
function row(
  key: string = "codec/key",
  lease: string = "0",
  expiresAt: number | null = null,
  payload: string = encodeRecordPayload(
    { key, value: new Uint8Array([1]), metadata: { owner: "codec" } },
    "operation",
    expiresAt
  )
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    key: encodeText(key),
    value: encodeText(payload),
    mod_revision: "2",
    lease
  })
}

/** Expects one secret-safe etcd protocol rejection. */
function protocol(operation: () => unknown): void {
  expect(operation).toThrow(expect.objectContaining({ code: "LIKEGO_ETCD_STORE_PROTOCOL" }))
}

describe("decimal and base64 codec", () => {
  test("validates exact signed int64 and revision carriers", () => {
    expect(decimal("0", true, "read")).toBe("0")
    expect(decimal("-1", false, "read")).toBe("-1")
    expect(revisionDecimal("1", false, "read")).toBe("1")
    expect(compareRevision("9223372036854775807")).toBe("9223372036854775807")
    for (const value of [1, "01", "-0", "0", "9223372036854775808", "-9223372036854775809"]) {
      protocol(() => decimal(value, false, "read"))
    }
    protocol(() => revisionDecimal("-1", false, "read"))
    expect(() => compareRevision("0")).toThrow(TypeError)
    expect(() => compareRevision("9223372036854775808")).toThrow(RangeError)
  })

  test("round-trips every base64 tail and rejects ambiguous encodings", () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([1]),
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2, 3])
    ]) {
      const encoded = encodeBase64(bytes)
      expect(decodeBase64(encoded, 3, "read")).toEqual(bytes)
    }
    for (const value of [null, "A", "!!!!", "AB=="]) {
      protocol(() => decodeBase64(value, 3, "read"))
    }
    protocol(() => decodeBase64("AQID", 2, "read"))
  })
})

describe("record codec", () => {
  test("validates Store key and payload bounds", () => {
    expect(storeKey("😀", false)).toBe("😀")
    expect(storeKey("", true)).toBe("")
    for (const key of ["", "\ud800", "\udc00"]) {
      expect(() => storeKey(key, false)).toThrow(TypeError)
    }
    expect(() => storeKey("a".repeat(maximumKeyBytes + 1), false)).toThrow(RangeError)
    expect(() =>
      encodeRecordPayload(
        { key: "large", value: new Uint8Array(maximumValueBytes + 1) },
        "operation",
        null
      )
    ).toThrow(RangeError)
    expect(() =>
      encodeRecordPayload(
        {
          key: "payload",
          value: new Uint8Array(),
          metadata: { oversized: "x".repeat(maximumPayloadBytes) }
        },
        "operation",
        null
      )
    ).toThrow(RangeError)
  })

  test("decodes persistent and lease-backed rows defensively", () => {
    const persistent = decodeRow(row(), "read")
    expect(persistent.record).toMatchObject({
      key: "codec/key",
      revision: "2",
      expiresAt: null,
      metadata: { owner: "codec" }
    })
    const expiring = decodeRow(row("codec/ttl", "7", 1234), "read")
    expect(expiring.record.expiresAt).toBe(1234)
    expect(matches(persistent, persistent.payload, "0")).toBeTrue()
    expect(matches(null, persistent.payload, "0")).toBeFalse()
    expect(matches(persistent, "different", "0")).toBeFalse()
    expect(matches(persistent, persistent.payload, "7")).toBeFalse()
  })

  test("maps every malformed gateway row to a body-independent protocol error", () => {
    protocol(() => decodeRow(null, "read"))
    protocol(() => decodeRow({ ...row(), key: encodeBase64(new Uint8Array([255])) }, "read"))
    protocol(() => decodeRow({ ...row(), mod_revision: "-1" }, "read"))
    protocol(() => decodeRow({ ...row(), value: encodeText("not-json") }, "read"))
    protocol(() => decodeRow({ ...row(), value: encodeText("null") }, "read"))
    protocol(() =>
      decodeRow({ ...row(), value: encodeText(JSON.stringify({ version: 1 })) }, "read")
    )
    const payloads: unknown[] = [
      { version: 2, operation: "x", value: "", metadata: {}, expiresAt: null },
      { version: 1, operation: "", value: "", metadata: {}, expiresAt: null },
      { version: 1, operation: "\ud800", value: "", metadata: {}, expiresAt: null },
      { version: 1, operation: "x", value: "", metadata: {}, expiresAt: -1 },
      { version: 1, operation: "x", value: "", metadata: {}, expiresAt: 1 },
      { version: 1, operation: "x", value: "", metadata: null, expiresAt: null },
      { version: 1, operation: "x", value: "", metadata: { x: 1 }, expiresAt: null },
      { version: 1, operation: "x", value: "!!!!", metadata: {}, expiresAt: null }
    ]
    for (const payload of payloads) {
      protocol(() => decodeRow({ ...row(), value: encodeText(JSON.stringify(payload)) }, "read"))
    }
    protocol(() => decodeRow(row("codec/mismatch", "9", null), "read"))
  })
})

describe("range and cursor codec", () => {
  test("builds exact prefix boundaries and page starts", () => {
    expect(prefixRangeEnd("")).toBe("AA==")
    expect(prefixRangeEnd("ab")).toBe(encodeText("ac"))
    expect(pageStart("", null)).toBe("AA==")
    expect(pageStart("ab", null)).toBe(encodeText("ab"))
    expect(pageStart("ab", "ab/z")).toBe(encodeText("ab/z\0"))
  })

  test("round-trips and strictly binds opaque cursors", () => {
    const value = encodeCursor("prefix/", "prefix/key", "7")
    expect(decodeCursor(value, "prefix/")).toEqual({
      prefix: "prefix/",
      lastKey: "prefix/key",
      revision: "7"
    })
    const invalid = [
      "!",
      "A",
      cursorValue(null),
      cursorValue({ version: 1 }),
      cursorValue({ version: 2, prefix: "prefix/", lastKey: "prefix/key", revision: "7" }),
      cursorValue({ version: 1, prefix: "other/", lastKey: "prefix/key", revision: "7" }),
      cursorValue({ version: 1, prefix: "prefix/", lastKey: "", revision: "7" }),
      cursorValue({ version: 1, prefix: "prefix/", lastKey: "\ud800", revision: "7" }),
      cursorValue({ version: 1, prefix: "prefix/", lastKey: "prefix/key", revision: 7 }),
      encodeCursor("prefix/", "prefix/key", "0"),
      encodeCursor("prefix/", "x".repeat(maximumKeyBytes + 1), "7"),
      encodeCursor("prefix/", "other/key", "7")
    ]
    for (const candidate of invalid) {
      expect(() => decodeCursor(candidate, "prefix/")).toThrow(TypeError)
    }
  })
})
