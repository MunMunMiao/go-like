import { background, deadlineExceeded, withCancelCause } from "@likego/context"
import { expect, test } from "bun:test"

import { newHttpError, rollbackFailure } from "../src/errors"
import { postJson, postWatch, retryable } from "../src/http"
import { captureOptions, etcdOrigin, operationOptions } from "../src/options"
import { completion, operationLease, signalFailure, waitForSignal } from "../src/runtime"
import type { EtcdFetch } from "../src/types"

/** Creates one operation snapshot around a borrowed Fetch. */
function options(fetch: EtcdFetch, token?: string) {
  const captured = captureOptions({
    fetch,
    address: "https://etcd.example",
    ...(token === undefined ? {} : { token })
  })
  return operationOptions(captured, captured.common, 20)
}

test("HTTP boundary covers abort, invalid JSON, watch status, and empty body", async () => {
  const before = new AbortController()
  const beforeFailure = new Error("before request")
  before.abort(beforeFailure)
  const unused: EtcdFetch = async function unusedFetch(): Promise<Response> {
    throw new Error("must not execute")
  }
  await expect(postJson(options(unused), "range", "/v3/kv/range", {}, before.signal)).rejects.toBe(
    beforeFailure
  )

  const during = new AbortController()
  const duringFailure = new Error("during request")
  const aborting: EtcdFetch = async function abortingFetch(): Promise<Response> {
    during.abort(duringFailure)
    throw new Error("private Fetch graph")
  }
  await expect(
    postJson(options(aborting), "range", "/v3/kv/range", {}, during.signal)
  ).rejects.toBe(duringFailure)

  const invalid: EtcdFetch = async function invalidJson(): Promise<Response> {
    return new Response("not-json")
  }
  await expect(
    postJson(options(invalid), "range", "/v3/kv/range", {}, new AbortController().signal)
  ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })

  const denied: EtcdFetch = async function deniedWatch(): Promise<Response> {
    return new Response(null, { status: 403 })
  }
  await expect(postWatch(options(denied), {}, new AbortController().signal)).rejects.toMatchObject({
    code: "LIKEGO_ETCD_HTTP",
    status: 403
  })
  const bodyless: EtcdFetch = async function bodylessWatch(): Promise<Response> {
    return new Response(null)
  }
  await expect(postWatch(options(bodyless), {}, new AbortController().signal)).rejects.toThrow(
    "has no body"
  )
})

test("retry classification is exact", () => {
  expect(retryable(deadlineExceeded)).toBeTrue()
  expect(retryable(null)).toBeFalse()
  expect(retryable({ code: "OTHER" })).toBeFalse()
  expect(retryable({ code: "LIKEGO_ETCD_TRANSPORT" })).toBeTrue()
  expect(retryable({ code: "LIKEGO_ETCD_HTTP", status: "500" })).toBeFalse()
  expect(retryable(newHttpError("range", 408))).toBeTrue()
  expect(retryable(newHttpError("range", 425))).toBeTrue()
  expect(retryable(newHttpError("range", 429))).toBeTrue()
  expect(retryable(newHttpError("range", 500))).toBeTrue()
  expect(retryable(newHttpError("range", 404))).toBeFalse()
})

test("provider option and rollback errors cover remaining validation boundaries", () => {
  expect(() => etcdOrigin("ftp://etcd.example")).toThrow("HTTP or HTTPS")
  expect(() =>
    captureOptions({
      fetch: unusedFetch,
      address: "https://etcd.example",
      token: "\u0000"
    })
  ).toThrow("header value")
  const primary = new Error("primary")
  expect(rollbackFailure(primary, [])).toBe(primary)
  const aggregate = rollbackFailure(primary, [new Error("rollback")])
  expect(aggregate).toBeInstanceOf(AggregateError)
  expect(aggregate).toMatchObject({ errors: [primary, expect.any(Error)] })
})

/** Fetch placeholder used only by synchronous option validation. */
async function unusedFetch(): Promise<Response> {
  return Response.json({})
}

test("runtime primitives propagate caller, owner, timer, and completion failures", async () => {
  const [ctx, cancel] = withCancelCause(background())
  const callerFailure = new Error("caller stopped")
  const callerLease = operationLease(ctx, null, 1_000)
  cancel(callerFailure)
  expect(callerLease.signal.aborted).toBeTrue()
  callerLease.release()

  const owner = new AbortController()
  const ownerLease = operationLease(background(), owner.signal, 1_000)
  const ownerFailure = new Error("owner stopped")
  owner.abort(ownerFailure)
  expect(ownerLease.signal.reason).toBe(ownerFailure)
  ownerLease.release()

  const timed = operationLease(background(), null, 1)
  await Bun.sleep(5)
  expect(timed.signal.reason).toBe(deadlineExceeded)
  timed.release()
  expect(signalFailure(timed.signal, "fallback")).toBe(deadlineExceeded)

  const already = new AbortController()
  const alreadyFailure = new Error("already")
  already.abort(alreadyFailure)
  await expect(waitForSignal(already.signal, 1)).rejects.toBe(alreadyFailure)
  const pending = new AbortController()
  const wait = waitForSignal(pending.signal, 1_000)
  const pendingFailure = new Error("pending")
  pending.abort(pendingFailure)
  await expect(wait).rejects.toBe(pendingFailure)

  const terminal = completion()
  const terminalFailure = new Error("terminal")
  terminal.reject(terminalFailure)
  await expect(terminal.promise).rejects.toBe(terminalFailure)
})
