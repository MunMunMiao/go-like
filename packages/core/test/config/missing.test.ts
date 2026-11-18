import { expect, test } from "bun:test"

import { admitConfigObject } from "../../src/config/value"
import { newConfigSourceMissingError } from "../../src/config/missing"

test("builds the stable missing-document error", () => {
  const error = newConfigSourceMissingError("vault")
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe("ConfigSourceMissingError")
  expect(error.code).toBe("GO_LIKE_CONFIG_SOURCE_MISSING")
  expect(error.sourceName).toBe("vault")
  expect(error.message).toBe('configuration source "vault" document is missing')
  expect(Object.isFrozen(error)).toBe(true)
  expect(() => newConfigSourceMissingError("")).toThrow(
    "configuration source name must be a non-empty string"
  )
})

test("admits only an object root and names the origin", () => {
  expect(admitConfigObject({ port: 1 }, "memory")).toEqual({ port: 1 })
  expect(() => admitConfigObject("no", "memory")).toThrow(
    "configuration root must be an object (memory)"
  )
  expect(() => admitConfigObject({}, "")).toThrow("configuration origin must be a non-empty string")
  const hostile = new Proxy(
    {},
    {
      ownKeys(): string[] {
        throw new RangeError("keys failed")
      }
    }
  )
  expect(() => admitConfigObject(hostile, "memory")).toThrow(RangeError)
})
