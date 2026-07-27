import { background, deadlineExceeded, withCancelCause } from "@likego/context"
import { expect, test } from "bun:test"

import {
  boundaryError,
  isNoNode,
  isNotEmpty,
  isRetryable,
  newAuthenticationError,
  newOperationError
} from "../src/errors"
import {
  captureOptions,
  clientOptions,
  operationOptions,
  zookeeperAddress,
  zookeeperRoot
} from "../src/options"
import {
  completion,
  contextFailure,
  operationLease,
  signalFailure,
  waitForSignal
} from "../src/runtime"
import { fakeZookeeper } from "./helpers"

test("ZooKeeper options validate addresses, roots, credentials, and bounded controls", () => {
  const factory = fakeZookeeper().factory
  expect(zookeeperAddress("localhost")).toBe("localhost")
  expect(zookeeperAddress("zk.example:02181")).toBe("zk.example:2181")
  for (const value of ["", "a,b", "host/path", "user@host", "host name", "x".repeat(513)]) {
    expect(() => zookeeperAddress(value)).toThrow("credentials-free")
  }
  expect(() => zookeeperAddress("bad!host:2181")).toThrow("host is invalid")
  for (const value of ["host:", "host:no", "host:0", "host:65536"]) {
    expect(() => zookeeperAddress(value)).toThrow("port is invalid")
  }
  expect(zookeeperRoot("/likego/registry")).toBe("/likego/registry")
  for (const value of ["/", "relative", "/tail/", "/two//parts", "/bad\u0000path"]) {
    expect(() => zookeeperRoot(value)).toThrow("absolute non-root")
  }
  expect(() => zookeeperRoot("/a/../b")).toThrow("relative path")
  expect(() => captureOptions(null as never, factory)).toThrow("must be an object")
  expect(() => captureOptions({ address: "fake:2181", auth: null as never }, factory)).toThrow(
    "auth must be an object"
  )
  expect(() =>
    captureOptions(
      { address: "fake:2181", auth: { scheme: "bad scheme", credential: "x" } },
      factory
    )
  ).toThrow("scheme is invalid")
  expect(() =>
    captureOptions(
      { address: "fake:2181", auth: { scheme: "digest", credential: 1 as never } },
      factory
    )
  ).toThrow("string or Uint8Array")
  expect(() =>
    captureOptions({ address: "fake:2181", auth: { scheme: "digest", credential: "" } }, factory)
  ).toThrow("byte length")
  expect(() => captureOptions({ address: "fake:2181", acl: "creator" }, factory)).toThrow(
    "requires authentication"
  )
  expect(() => captureOptions({ address: "fake:2181", acl: "private" as never }, factory)).toThrow(
    "acl must be open or creator"
  )
  expect(() =>
    captureOptions({ address: "fake:2181", clientFactory: 1 as never }, factory)
  ).toThrow("must be callable")
  for (const options of [
    { sessionTimeoutMs: 1 },
    { spinDelayMs: 0 },
    { retries: -1 },
    { retryInitialMs: 0 },
    { retryInitialMs: 10, retryMaximumMs: 9 },
    { reconcileIntervalMs: 99 },
    { watchBufferSize: 0 },
    { watchBufferSize: 4_097 }
  ]) {
    expect(() => captureOptions({ address: "fake:2181", ...options }, factory)).toThrow(
      "must be an integer"
    )
  }
  const credential = new Uint8Array([1, 2, 3])
  const captured = captureOptions(
    {
      address: "fake:2181",
      root: "/custom",
      auth: { scheme: "digest", credential },
      acl: "creator",
      clientFactory: factory
    },
    factory
  )
  credential[0] = 9
  const scoped = operationOptions(captured, captured.common)
  expect(scoped.connectionString).toBe("fake:2181")
  expect(clientOptions(scoped).auth?.credential).toEqual(new Uint8Array([1, 2, 3]))
  expect(() => operationOptions(captured, captured.common, 0)).toThrow("operation timeoutMs")
})

test("errors and runtime helpers preserve stable identities and Context causes", async () => {
  const operation = newOperationError("children", -101, true)
  expect(operation).toMatchObject({
    code: "LIKEGO_ZOOKEEPER_OPERATION",
    operation: "children",
    nativeCode: -101,
    retryable: true
  })
  expect(newAuthenticationError()).toMatchObject({
    code: "LIKEGO_ZOOKEEPER_AUTHENTICATION"
  })
  expect(boundaryError("hidden", "safe").message).toBe("safe")
  expect(boundaryError(operation, "safe")).toBe(operation)
  expect(isRetryable(operation)).toBe(true)
  expect(isNoNode(operation)).toBe(true)
  expect(isNotEmpty(newOperationError("remove", -111, false))).toBe(true)

  const [ctx, cancel] = withCancelCause(background())
  const exact = new Error("exact")
  const lease = operationLease(ctx, null, 10_000)
  cancel(exact)
  expect(lease.signal.reason).toBe(exact)
  expect(contextFailure(ctx)).toBe(exact)
  expect(signalFailure(lease.signal, "fallback")).toBe(exact)
  lease.release()

  const owner = new AbortController()
  const ownedLease = operationLease(background(), owner.signal, 10_000)
  owner.abort(exact)
  expect(ownedLease.signal.reason).toBe(exact)
  ownedLease.release()

  const deadlineLease = operationLease(background(), null, 1)
  await Bun.sleep(5)
  expect(deadlineLease.signal.reason).toBe(deadlineExceeded)
  deadlineLease.release()

  const controller = new AbortController()
  const wait = waitForSignal(controller.signal, 10_000)
  controller.abort(exact)
  await expect(wait).rejects.toBe(exact)
  await expect(waitForSignal(new AbortController().signal, 1)).resolves.toBeUndefined()

  const terminal = completion()
  terminal.resolve()
  await terminal.promise
})
