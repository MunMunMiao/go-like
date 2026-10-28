import { expect, test } from "bun:test"

import {
  collectCleanupFailure,
  type CleanupFailure,
  finalizeWithCleanup
} from "../e2e/harness/cleanup"

test("cleanup failures are collected in execution order without stopping later cleanup", async () => {
  const observed: string[] = []
  const failures: CleanupFailure[] = []
  const first = new Error("first cleanup")
  const second = new Error("second cleanup")
  await collectCleanupFailure(failures, "first", () => {
    observed.push("first")
    throw first
  })
  await collectCleanupFailure(failures, "success", () => {
    observed.push("success")
  })
  await collectCleanupFailure(failures, "second", async () => {
    observed.push("second")
    throw second
  })
  expect(observed).toEqual(["first", "success", "second"])
  expect(failures.map((failure) => failure.error)).toEqual([first, second])
})

test("finalization preserves single primary and cleanup identities", () => {
  const primary = new Error("primary")
  const cleanup = new Error("cleanup")
  expect(() => finalizeWithCleanup(primary, [], "joint")).toThrow(primary)
  expect(() => finalizeWithCleanup(null, [{ label: "cleanup", error: cleanup }], "joint")).toThrow(
    cleanup
  )
})

test("finalization aggregates primary first and cleanup failures in order", () => {
  const primary = new Error("primary")
  const cleanupA = new Error("cleanup-a")
  const cleanupB = new Error("cleanup-b")
  let failure: unknown = null
  try {
    finalizeWithCleanup(
      primary,
      [
        { label: "a", error: cleanupA },
        { label: "b", error: cleanupB }
      ],
      "joint failure"
    )
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).message).toBe("joint failure")
  expect((failure as AggregateError).errors).toEqual([primary, cleanupA, cleanupB])
})

test("non-Error cleanup values retain their cause", async () => {
  const cause = Object.freeze({ code: "CLEANUP_VALUE" })
  const failures: CleanupFailure[] = []
  await collectCleanupFailure(failures, "resource cleanup", () => {
    throw cause
  })
  expect(failures).toHaveLength(1)
  expect(failures[0]?.error.message).toBe("resource cleanup failed")
  expect(failures[0]?.error.cause).toBe(cause)
})
