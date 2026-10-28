import { expect, test } from "bun:test"

import * as HealthPackage from "../src/index"

test("exports exactly the Health runtime factories", () => {
  expect(Object.keys(HealthPackage)).toEqual(["newProbeRegistry"])
  expect(HealthPackage).not.toHaveProperty("Probe")
  expect(HealthPackage).not.toHaveProperty("ProbeKind")
  expect(HealthPackage).not.toHaveProperty("ProbeOptions")
  expect(HealthPackage).not.toHaveProperty("ProbeRegistry")
  expect(HealthPackage).not.toHaveProperty("createHealthFetch")
  expect(HealthPackage).not.toHaveProperty("NewProbeRegistry")
})

test("creates an isolated structural probe registry", () => {
  const registry = HealthPackage.newProbeRegistry()

  expect(typeof registry.register).toBe("function")
  expect(typeof registry.check).toBe("function")
})
