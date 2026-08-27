import { expect, test } from "bun:test"

import * as Core from "../src/index"
import * as Lifecycle from "../src/lifecycle"
import * as NodeRuntime from "../src/node"

const RootRuntimeExports = [
  "afterStart",
  "afterStop",
  "fromContext",
  "beforeStart",
  "beforeStop",
  "context",
  "endpoint",
  "id",
  "metadata",
  "name",
  "newApp",
  "registrar",
  "registrarTimeout",
  "server",
  "startTimeout",
  "stopTimeout",
  "version",
  "newContext"
] as const

test("root exports exactly the canonical Kratos-style runtime API", () => {
  expect(Object.keys(Core).sort()).toEqual([...RootRuntimeExports].sort())
})

test("startTimeout accepts only the public timer range", () => {
  const option: unknown = Reflect.get(Core, "startTimeout")
  expect(typeof option).toBe("function")
  if (typeof option !== "function") return
  for (const value of [-1, 1.5, Number.NaN, 2_147_483_648]) {
    expect(() => Reflect.apply(option, undefined, [value])).toThrow(RangeError)
  }
  expect(() => Reflect.apply(option, undefined, [0])).not.toThrow()
  expect(() => Reflect.apply(option, undefined, [2_147_483_647])).not.toThrow()
})

test("lifecycle subpath retains the shared wait helper used by providers", () => {
  expect(Object.keys(Lifecycle)).toEqual(["waitForContext"])
})

test("node subpath exports only the App signal option", () => {
  expect(Object.keys(NodeRuntime)).toEqual(["signal"])
})

test("removed lifecycle concepts have no runtime compatibility facade", () => {
  for (const value of ["endpoints", "hardDrainTimeout", "newNodeRuntimeHost", "run"]) {
    expect(Core).not.toHaveProperty(value)
    expect(NodeRuntime).not.toHaveProperty(value)
  }
})
