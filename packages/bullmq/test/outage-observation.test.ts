import { describe, expect, test } from "bun:test"

import { outageErrorDelta } from "./outage-observation"

describe("BullMQ outage error observation", () => {
  test("does not let a pre-outage observational error satisfy the outage delta", () => {
    const errors = [new Error("pre-outage observational error")]
    const baseline = errors.length

    expect(errors.length > 0).toBe(true)
    expect(outageErrorDelta(errors, baseline)).toBe(0)

    errors.push(new Error("Redis outage error"))
    expect(outageErrorDelta(errors, baseline)).toBe(1)
  })

  test("rejects a baseline that cannot be a prefix of the observation log", () => {
    expect(() => outageErrorDelta([], 1)).toThrow(RangeError)
    expect(() => outageErrorDelta([], -1)).toThrow(RangeError)
    expect(() => outageErrorDelta([], 0.5)).toThrow(RangeError)
  })
})
