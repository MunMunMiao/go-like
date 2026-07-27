import { expect, test } from "bun:test"
import { createApp } from "h3"

import * as H3Bridge from "../src/index"

test("exports only the H3 handler factory", () => {
  expect(Object.keys(H3Bridge)).toEqual(["newH3Handler"])
  expect(H3Bridge).not.toHaveProperty("H3")
  expect(H3Bridge).not.toHaveProperty("get")
  expect(H3Bridge).not.toHaveProperty("use")
})

test("validates the native application boundary synchronously", () => {
  expect(() => Reflect.apply(H3Bridge.newH3Handler, undefined, [null])).toThrow(TypeError)
  expect(() => Reflect.apply(H3Bridge.newH3Handler, undefined, [{}])).toThrow(TypeError)
  expect(typeof H3Bridge.newH3Handler(createApp())).toBe("function")
})
