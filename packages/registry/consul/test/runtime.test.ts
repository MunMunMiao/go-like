import { background, deadlineExceeded, withCancelCause } from "@likego/context"
import { expect, test } from "bun:test"

import { boundaryError, newHttpError, newTransportError, rollbackFailure } from "../src/errors"
import {
  completion,
  contextFailure,
  ignoreFailure,
  operationLease,
  signalFailure,
  waitForSignal
} from "../src/runtime"
import { queryText } from "../src/http"
import { captureOptions, operationOptions } from "../src/options"

test("provider errors are stable, ordered, and secret-safe", () => {
  const native = Object.assign(new Error("secret native"), {
    request: new Request("https://example.test")
  })
  expect(newHttpError("get", 403)).toMatchObject({
    name: "ConsulHttpError",
    code: "LIKEGO_CONSUL_HTTP",
    operation: "get",
    status: 403
  })
  const retained = newTransportError("register", native, false)
  expect(retained.cause).toBe(native)
  const sanitized = newTransportError("register", native, true)
  expect(sanitized.cause).not.toBe(native)
  expect("request" in sanitized.cause).toBe(false)
  const primary = new Error("primary")
  expect(rollbackFailure(primary, [])).toBe(primary)
  const secondary = new Error("secondary")
  expect((rollbackFailure(primary, [secondary]) as AggregateError).errors).toEqual([
    primary,
    secondary
  ])
  expect(boundaryError("bad", "normalized").message).toBe("normalized")
})

test("operation lease links exact Context, owner, timeout, and idempotent release", async () => {
  const [ctx, cancel] = withCancelCause(background())
  const owner = new AbortController()
  const lease = operationLease(ctx, owner.signal, 1_000)
  const failure = new Error("caller cause")
  cancel(failure)
  expect(lease.signal.aborted).toBe(true)
  expect(contextFailure(ctx)).toBe(failure)
  lease.release()
  lease.release()

  const ownerLease = operationLease(background(), owner.signal, 1_000)
  const ownerFailure = new Error("owner cause")
  owner.abort(ownerFailure)
  expect(signalFailure(ownerLease.signal, "unused")).toBe(ownerFailure)
  ownerLease.release()

  const timeoutLease = operationLease(background(), null, 1)
  await Bun.sleep(5)
  expect(timeoutLease.signal.reason).toBe(deadlineExceeded)
  timeoutLease.release()
})

test("completion and signal waits settle exactly once", async () => {
  ignoreFailure(new Error("observed"))
  const completed = completion()
  expect(completed.promise).toBe(completed.promise)
  completed.resolve()
  completed.reject(new Error("late"))
  await expect(completed.promise).resolves.toBeUndefined()

  const owner = new AbortController()
  const wait = waitForSignal(owner.signal, 1_000)
  const failure = new Error("wait stopped")
  owner.abort(failure)
  await expect(wait).rejects.toBe(failure)
  await expect(waitForSignal(owner.signal, 1)).rejects.toBe(failure)
  await expect(waitForSignal(new AbortController().signal, 1)).resolves.toBeUndefined()
})

test("HTTP boundary rejects an already-aborted request before borrowing Fetch", async () => {
  let fetchCalls = 0
  const provider = captureOptions({
    address: "https://consul.example",
    async fetch(): Promise<Response> {
      fetchCalls += 1
      return Response.json([])
    }
  })
  const options = operationOptions(provider, provider.common)
  const owner = new AbortController()
  const failure = new Error("request already stopped")
  owner.abort(failure)

  await expect(
    queryText(
      options,
      "get",
      new URL("/v1/health/service/orders", options.origin),
      owner.signal,
      false
    )
  ).rejects.toBe(failure)
  expect(fetchCalls).toBe(0)
})
