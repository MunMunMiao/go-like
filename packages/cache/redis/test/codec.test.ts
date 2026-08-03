import { expect, test } from "bun:test"

import { decodeRedisCacheValue, encodeRedisCacheValue } from "../src/codec"

test("Redis carrier round-trips detached binary values canonically", () => {
  const input = new Uint8Array([0, 1, 127, 128, 255])
  const wire = encodeRedisCacheValue(input)
  expect(wire).toBe("v1:AAF/gP8=")
  input[0] = 9
  const first = decodeRedisCacheValue(wire, 5)
  expect(first).toEqual(new Uint8Array([0, 1, 127, 128, 255]))
  first[0] = 7
  expect(decodeRedisCacheValue(wire, 5)).toEqual(new Uint8Array([0, 1, 127, 128, 255]))
  expect(encodeRedisCacheValue(new Uint8Array())).toBe("v1:")
})

test("Redis carrier rejects foreign malformed non-canonical and oversized values", () => {
  for (const value of [null, "", "v2:AA==", "v1:A", "v1:AB==", "v1:!!!!"]) {
    expect(() => decodeRedisCacheValue(value, 10)).toThrow("canonical LikeGo carrier")
  }
  expect(() => decodeRedisCacheValue("v1:AAE=", 1)).toThrow("canonical LikeGo carrier")
})
