import { describe, expect, test } from "bun:test"

import { struct } from "../../src/struct"
import { StructError } from "../../src/struct/errors"

import { decodeJsonBody, encodeJsonBody } from "../../src/transport/internal/json"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("Q6-01 nullable union JSON bodies", () => {
  test("decodeJsonBody and encodeJsonBody accept null for a nullable object union", () => {
    const schema = struct.or(struct.object({ name: struct.string() }).null(), struct.string())

    expect(decodeJsonBody(schema, encoder.encode("null"))).toBeNull()
    expect(decoder.decode(encodeJsonBody(schema, null))).toBe("null")
    expect(() => decodeJsonBody(schema, encoder.encode("1"))).toThrow(StructError)
  })
})
