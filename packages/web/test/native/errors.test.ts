import { expect, test } from "bun:test"

import {
  newAlreadyStartedError,
  newForceCloseError,
  newUnexpectedCloseError,
  type NativeRuntimeTag
} from "../../src/native-errors"

const bun: NativeRuntimeTag<"bun"> = { id: "bun", name: "Bun", code: "BUN" }
const deno: NativeRuntimeTag<"deno"> = { id: "deno", name: "Deno", code: "DENO" }

test("already-started errors are frozen structural errors with per-runtime identity", () => {
  const bunError = newAlreadyStartedError(bun, "running")
  const denoError = newAlreadyStartedError(deno, "stopped")

  expect(bunError).toBeInstanceOf(Error)
  expect(Object.isFrozen(bunError)).toBe(true)
  expect(bunError).toMatchObject({
    name: "BunServerAlreadyStartedError",
    code: "GO_LIKE_BUN_SERVER_ALREADY_STARTED",
    status: "running",
    message: "bun web server has already started"
  })
  expect(denoError).toMatchObject({
    name: "DenoServerAlreadyStartedError",
    code: "GO_LIKE_DENO_SERVER_ALREADY_STARTED",
    status: "stopped",
    message: "deno web server has already started"
  })
})

test("force-close errors report the budget and the in-flight request count", () => {
  const bunError = newForceCloseError(bun, 25, 3)
  const denoError = newForceCloseError(deno, 0, 0)

  expect(Object.isFrozen(bunError)).toBe(true)
  expect(bunError).toMatchObject({
    name: "BunServerForceCloseError",
    code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE",
    timeoutMs: 25,
    activeRequests: 3,
    message: "bun web server force closed after 25ms"
  })
  expect(denoError).toMatchObject({
    name: "DenoServerForceCloseError",
    code: "GO_LIKE_DENO_SERVER_FORCE_CLOSE",
    timeoutMs: 0,
    activeRequests: 0,
    message: "deno web server force closed after 0ms"
  })
  expect(bunError).not.toHaveProperty("activeConnections")
})

test("unexpected-close errors carry a stable per-runtime code", () => {
  const denoError = newUnexpectedCloseError(deno)
  const bunError = newUnexpectedCloseError(bun)

  expect(Object.isFrozen(denoError)).toBe(true)
  expect(denoError).toMatchObject({
    name: "DenoServerUnexpectedCloseError",
    code: "GO_LIKE_DENO_SERVER_UNEXPECTED_CLOSE",
    message: "deno web server closed unexpectedly"
  })
  expect(bunError).toMatchObject({
    name: "BunServerUnexpectedCloseError",
    code: "GO_LIKE_BUN_SERVER_UNEXPECTED_CLOSE"
  })
})
