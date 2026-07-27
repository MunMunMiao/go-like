import { expect, test } from "bun:test"
import { Hono } from "hono"

import * as HonoBridge from "../src/index"

test("exports only the Hono handler factory", () => {
  expect(Object.keys(HonoBridge)).toEqual(["newHonoHandler"])
  expect(HonoBridge).not.toHaveProperty("Hono")
  expect(HonoBridge).not.toHaveProperty("get")
  expect(HonoBridge).not.toHaveProperty("use")
})

test("validates the native application boundary synchronously", () => {
  expect(() => Reflect.apply(HonoBridge.newHonoHandler, undefined, [null])).toThrow(TypeError)
  expect(() => Reflect.apply(HonoBridge.newHonoHandler, undefined, [{}])).toThrow(TypeError)
  expect(typeof HonoBridge.newHonoHandler(new Hono())).toBe("function")
})
