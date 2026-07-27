import { expect, test } from "bun:test"

import { expiresIn } from "../src/index"
import { putOptions } from "../src/provider"

test("put options are immutable ordered and last-wins", () => {
  const selected = putOptions([expiresIn(10), expiresIn(20)])
  expect(selected).toEqual({ expiresInMs: 20 })
  expect(Object.isFrozen(selected)).toBe(true)
  expect(putOptions()).toEqual({ expiresInMs: null })
})

test("put option constructors and reducer outputs fail closed", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => expiresIn(value)).toThrow(RangeError)
  }
  expect(() => Reflect.apply(putOptions, undefined, [[null]])).toThrow(TypeError)
  expect(() =>
    Reflect.apply(putOptions, undefined, [
      [
        function invalid(): null {
          return null
        }
      ]
    ])
  ).toThrow(TypeError)
})
