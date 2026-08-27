import { describe, expect, test } from "bun:test"

import * as ContextPackage from "../src/index"
import { background, deadlineExceeded, todo } from "../src/index"

const RuntimeExports = [
  "afterFunc",
  "background",
  "canceled",
  "cause",
  "deadlineExceeded",
  "todo",
  "withCancel",
  "withCancelCause",
  "withDeadline",
  "withDeadlineCause",
  "withoutCancel",
  "withTimeout",
  "withTimeoutCause",
  "withValue"
] as const

const RemovedRuntimeExports = [
  "AfterFunc",
  "Background",
  "Canceled",
  "Cause",
  "DeadlineExceeded",
  "TODO",
  "WithCancel",
  "WithCancelCause",
  "WithDeadline",
  "WithDeadlineCause",
  "WithoutCancel",
  "WithTimeout",
  "WithTimeoutCause",
  "WithValue"
] as const

test("exports exactly the frozen runtime API", () => {
  expect(Object.keys(ContextPackage).sort()).toEqual([...RuntimeExports].sort())
  for (const name of RemovedRuntimeExports) expect(ContextPackage).not.toHaveProperty(name)
})

test("deadlineExceeded is the stable frozen timeout sentinel", () => {
  expect(ContextPackage.deadlineExceeded).toBe(deadlineExceeded)
  expect(deadlineExceeded).toBeInstanceOf(Error)
  expect(Object.getPrototypeOf(deadlineExceeded)).toBe(Error.prototype)
  expect(Object.keys(deadlineExceeded).sort()).toEqual(["name", "temporary", "timeout"])
  expect(deadlineExceeded.name).toBe("DeadlineExceeded")
  expect(deadlineExceeded.message).toBe("context deadline exceeded")
  expect(deadlineExceeded.timeout()).toBe(true)
  expect(deadlineExceeded.temporary()).toBe(true)
  expect(Object.isFrozen(deadlineExceeded)).toBe(true)
})

describe("empty contexts", () => {
  test.each([
    ["background", background],
    ["todo", todo]
  ])("%s has no deadline, cancellation, error, or value", (_name, factory) => {
    const ctx = factory()
    const [deadline, ok] = ctx.deadline()

    expect(deadline).toBeInstanceOf(Date)
    expect(deadline.toISOString()).toBe("0001-01-01T00:00:00.000Z")
    expect(ctx.deadline()[0]).not.toBe(deadline)
    expect(ok).toBe(false)
    expect(ctx.done()).toBeNull()
    expect(ctx.err()).toBeNull()
    expect(ctx.value(Symbol("missing"))).toBeNull()
  })
})
