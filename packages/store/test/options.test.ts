import { expect, test } from "bun:test"

import { cursor, expiresIn, ifRevision, limit, prefix } from "../src/index"
import { deleteOptions, listOptions, writeOptions } from "../src/provider"

test("functional options are immutable, ordered, and last-wins", () => {
  const write = writeOptions(expiresIn(10), ifRevision("one"), expiresIn(20), ifRevision("two"))
  const deleted = deleteOptions(ifRevision("one"), ifRevision("two"))
  const listed = listOptions(
    prefix("a"),
    limit(1),
    cursor("one"),
    prefix("b"),
    limit(2),
    cursor("two")
  )

  expect(write).toEqual({ expiresInMs: 20, ifRevision: "two" })
  expect(deleted).toEqual({ ifRevision: "two" })
  expect(listed).toEqual({ prefix: "b", limit: 2, cursor: "two" })
  expect(Object.isFrozen(write)).toBe(true)
  expect(Object.isFrozen(deleted)).toBe(true)
  expect(Object.isFrozen(listed)).toBe(true)
  expect(writeOptions()).toEqual({ expiresInMs: null, ifRevision: null })
  expect(deleteOptions()).toEqual({ ifRevision: null })
  expect(listOptions()).toEqual({ prefix: "", limit: null, cursor: null })
  expect(prefix("💡")({ prefix: "", limit: null, cursor: null }).prefix).toBe("💡")
})

test("option constructors and reducer outputs fail closed", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => expiresIn(value)).toThrow(RangeError)
    expect(() => limit(value)).toThrow(RangeError)
  }
  expect(() => ifRevision("")).toThrow(TypeError)
  expect(() => ifRevision("\ud800")).toThrow(TypeError)
  expect(() => prefix("\udc00")).toThrow(TypeError)
  expect(() => cursor("")).toThrow(TypeError)
  expect(() => cursor("\ud800")).toThrow(TypeError)
  expect(() => writeOptions(null as never)).toThrow(TypeError)
  expect(() => deleteOptions(null as never)).toThrow(TypeError)
  expect(() => listOptions(null as never)).toThrow(TypeError)
  expect(() => writeOptions(() => null as never)).toThrow("write options")
  expect(() => deleteOptions(() => null as never)).toThrow("delete options")
  expect(() => listOptions(() => null as never)).toThrow("list options")
  expect(() => writeOptions(() => ({ expiresInMs: 0, ifRevision: null }))).toThrow(RangeError)
  expect(() => deleteOptions(() => ({ ifRevision: "" }))).toThrow(TypeError)
  expect(() => listOptions(() => ({ prefix: "", limit: 0, cursor: null }))).toThrow(RangeError)
})
