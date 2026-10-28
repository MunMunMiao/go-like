import { describe, expect, test } from "bun:test"

import {
  decodeBase64,
  decodeCursor,
  decodeRows,
  encodeBase64,
  encodeCursor,
  encodeRecordPayload
} from "../src/codec"

const KeyPrefix = "go-like/store/"

/** Wraps one go-like wire payload in a real Consul KV response row. */
function consulRow(payload: string, overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify([
    Object.assign(
      {
        Key: `${KeyPrefix}服务/一`,
        ModifyIndex: 42,
        Value: encodeBase64(new TextEncoder().encode(payload)),
        Session: "session-1"
      },
      overrides
    )
  ])
}

/** Creates one valid version-one go-like wire payload. */
function payload(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify(
    Object.assign(
      {
        version: 1,
        operation: "operation-1",
        value: "AP+A",
        metadata: { region: "华东" },
        expiresAt: 123_456
      },
      overrides
    )
  )
}

describe("Consul Store wire codec", () => {
  test("round-trips canonical standard base64 and snapshots the stable record payload", () => {
    const bytes = Uint8Array.of(0, 255, 128, 1)
    expect(encodeBase64(bytes)).toBe("AP+AAQ==")
    expect(Array.from(decodeBase64("AP+AAQ==", "read"))).toEqual([0, 255, 128, 1])

    const source = Uint8Array.of(1, 2, 3)
    const metadata = { owner: "payments" }
    const wire = encodeRecordPayload(
      { key: "orders", value: source, metadata },
      "operation-2",
      null
    )
    source[0] = 9
    metadata.owner = "mutated"
    expect(JSON.parse(wire)).toEqual({
      version: 1,
      operation: "operation-2",
      value: "AQID",
      metadata: { owner: "payments" },
      expiresAt: null
    })
  })

  test("round-trips prototype-named metadata as own fields", () => {
    const metadata = Object.fromEntries([
      ["__proto__", "sentinel"],
      ["constructor", "factory"]
    ])
    const wire = encodeRecordPayload(
      { key: "服务/一", value: new Uint8Array(), metadata },
      "operation-1",
      null
    )
    const captured = decodeRows(consulRow(wire), "read", KeyPrefix)[0]?.record.metadata

    expect(Object.getOwnPropertyDescriptor(captured, "__proto__")?.value).toBe("sentinel")
    expect(Object.getOwnPropertyDescriptor(captured, "constructor")?.value).toBe("factory")
  })

  test("decodes ModifyIndex, payload, metadata, expiry, and optional Session exactly", () => {
    const rows = decodeRows(consulRow(payload()), "read", KeyPrefix)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ payload: payload(), session: "session-1" })
    expect(rows[0]?.record).toEqual({
      key: "服务/一",
      value: Uint8Array.of(0, 255, 128),
      metadata: { region: "华东" },
      revision: "42",
      expiresAt: 123_456
    })
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(rows[0])).toBe(true)
    expect(Object.isFrozen(rows[0]?.record)).toBe(true)
    expect(Object.isFrozen(rows[0]?.record.metadata)).toBe(true)

    expect(
      decodeRows(consulRow(payload(), { Session: undefined }), "list", KeyPrefix)[0]?.session
    ).toBe(null)
    expect(decodeRows(consulRow(payload(), { Session: null }), "list", KeyPrefix)[0]?.session).toBe(
      null
    )
  })

  test("rejects malformed Consul rows and malformed go-like payloads without reflecting bodies", () => {
    const malformedRows = [
      "not-json",
      "{}",
      "[null]",
      consulRow(payload(), { Key: 1 }),
      consulRow(payload(), { Key: "outside/服务/一" }),
      consulRow(payload(), { Key: KeyPrefix.slice(0, -1) }),
      consulRow(payload(), { ModifyIndex: "42" }),
      consulRow(payload(), { ModifyIndex: 0 }),
      consulRow(payload(), { ModifyIndex: 1.5 }),
      consulRow(payload(), { Session: 1 }),
      consulRow(payload(), { Value: "not base64" }),
      consulRow(payload(), { Value: "/w==" }),
      consulRow("not-json"),
      consulRow("[]"),
      consulRow(payload({ version: 2 })),
      consulRow(payload({ operation: "" })),
      consulRow(payload({ metadata: [] })),
      consulRow(payload({ metadata: { bad: 1 } })),
      consulRow(payload({ expiresAt: -1.5 })),
      consulRow(payload({ expiresAt: "soon" })),
      consulRow(payload({ value: "*" }))
    ]
    for (const malformed of malformedRows) {
      try {
        decodeRows(malformed, "read", KeyPrefix)
        throw new Error("malformed row unexpectedly decoded")
      } catch (error) {
        expect(error).toMatchObject({
          name: "ConsulStoreProtocolError",
          code: "GO_LIKE_CONSUL_STORE_PROTOCOL",
          operation: "read"
        })
        expect(String(error)).not.toContain(malformed)
      }
    }
    expect(() => decodeBase64(null, "read")).toThrow("violated the protocol")
    expect(() => decodeBase64("A===", "read")).toThrow("violated the protocol")
  })

  test("normalizes native base64 decoder rejection to the stable protocol error", () => {
    const original = globalThis.atob
    Object.defineProperty(globalThis, "atob", {
      configurable: true,
      value(): never {
        throw new Error("native body must not escape")
      }
    })
    try {
      expect(() => decodeBase64("AAAA", "delete")).toThrow(
        "Consul Store delete response violated the protocol"
      )
    } finally {
      Object.defineProperty(globalThis, "atob", { configurable: true, value: original })
    }
  })

  test("round-trips a prefix-bound opaque cursor and rejects substitutions", () => {
    const encoded = encodeCursor("orders/", "orders/二", "42")
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain("orders")
    expect(decodeCursor(encoded, "orders/")).toEqual({ lastKey: "orders/二", index: "42" })

    const invalid = [
      "!",
      "bm90LWpzb24",
      encodeCursor("other/", "orders/二", "42"),
      encodeBase64(
        new TextEncoder().encode(
          JSON.stringify({ version: 2, prefix: "orders/", lastKey: "x", index: "0" })
        )
      ),
      encodeBase64(
        new TextEncoder().encode(JSON.stringify({ version: 1, prefix: "orders/", lastKey: "" }))
      )
    ]
    for (const candidate of invalid) {
      expect(() => decodeCursor(candidate, "orders/")).toThrow("cursor is invalid")
    }
  })
})
