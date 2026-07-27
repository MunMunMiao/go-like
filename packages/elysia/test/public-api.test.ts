import { expect, test } from "bun:test"
import { Elysia } from "elysia"

import * as ElysiaBridge from "../src/index"

test("exports only the Elysia handler factory", () => {
  expect(Object.keys(ElysiaBridge)).toEqual(["newElysiaHandler"])
  expect(ElysiaBridge).not.toHaveProperty("Elysia")
  expect(ElysiaBridge).not.toHaveProperty("get")
  expect(ElysiaBridge).not.toHaveProperty("use")
})

test("validates the native application boundary synchronously", () => {
  expect(() => Reflect.apply(ElysiaBridge.newElysiaHandler, undefined, [null])).toThrow(TypeError)
  expect(() => Reflect.apply(ElysiaBridge.newElysiaHandler, undefined, [{}])).toThrow(TypeError)
  expect(typeof ElysiaBridge.newElysiaHandler(new Elysia())).toBe("function")
})
