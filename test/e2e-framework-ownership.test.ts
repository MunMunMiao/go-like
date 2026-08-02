import { expect, test } from "bun:test"

import { findSuiteDefinition, suiteDefinitions } from "../e2e/definitions"
import { selectExecutionPlan } from "../e2e/selection"

const ReplacementIds = [
  "web-bridge-dist",
  "hono-bridge-dist",
  "h3-bridge-dist",
  "elysia-bridge-dist"
] as const
const CompatibilityIds = ["vanilla-node", "hono-node", "h3-node", "elysia-node"] as const
test("framework replacements own default coverage exactly once", () => {
  const definitions = suiteDefinitions()
  const suites = selectExecutionPlan(definitions, {
    kind: "scope",
    scope: "suites",
    processMode: "managed"
  })
  const all = selectExecutionPlan(definitions, {
    kind: "scope",
    scope: "all",
    processMode: "managed"
  })
  for (const id of ReplacementIds) {
    expect(definitions.filter((definition) => definition.id === id)).toHaveLength(1)
    expect(suites.filter((definition) => definition.id === id)).toHaveLength(1)
    expect(all.filter((definition) => definition.id === id)).toHaveLength(1)
    expect(findSuiteDefinition(id)?.cwd).toStartWith("packages/")
    expect(findSuiteDefinition(id)?.explicitOnly).not.toBe(true)
  }
  expect(all.filter((definition) => definition.id === "examples")).toHaveLength(1)
})

test("framework compatibility aliases remain explicit-only and selectable", () => {
  const definitions = suiteDefinitions()
  for (const id of CompatibilityIds) {
    const definition = findSuiteDefinition(id)
    expect(definition?.explicitOnly).toBe(true)
    expect(
      selectExecutionPlan(definitions, {
        kind: "suites",
        ids: [id],
        processMode: "managed"
      }).map((selected) => selected.id)
    ).toEqual([id])
  }
})
