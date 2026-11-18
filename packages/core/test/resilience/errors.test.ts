import { expect, test } from "bun:test"

import { circuitOpen } from "../../src/resilience/index"

test("circuit-open rejection is one immutable shared Error", () => {
  expect(circuitOpen).toBeInstanceOf(Error)
  expect(circuitOpen.name).toBe("CircuitOpenError")
  expect(circuitOpen.message).toBe("circuit breaker is open")
  expect(Object.isFrozen(circuitOpen)).toBe(true)
})
