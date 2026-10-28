import { background, cause, deadlineExceeded, withCancelCause } from "@go-like/context"
import { expect, test } from "bun:test"

import {
  contextFailure,
  ignoreFailure,
  operationLease,
  signalFailure,
  waitForSignal
} from "../src/runtime"

test("operation lease links caller, owner, deadline, and explicit release", async () => {
  const [callerContext, cancelCaller] = withCancelCause(background())
  const callerLease = operationLease(callerContext, null, 1_000)
  const callerFailure = new Error("caller canceled")
  cancelCaller(callerFailure)
  expect(callerLease.signal.aborted).toBe(true)
  expect(callerLease.signal.reason).toBe(callerFailure)
  expect(contextFailure(callerContext)).toBe(callerFailure)
  callerLease.release()

  const owner = new AbortController()
  const ownerLease = operationLease(background(), owner.signal, 1_000)
  const ownerFailure = new Error("owner stopped")
  owner.abort(ownerFailure)
  expect(ownerLease.signal.reason).toBe(ownerFailure)
  ownerLease.release()

  const [preCanceled, cancelPreCanceled] = withCancelCause(background())
  cancelPreCanceled(callerFailure)
  const preCanceledLease = operationLease(preCanceled, null, 1_000)
  expect(preCanceledLease.signal.reason).toBe(callerFailure)
  preCanceledLease.release()

  const preStoppedOwner = new AbortController()
  preStoppedOwner.abort(ownerFailure)
  const preStoppedLease = operationLease(background(), preStoppedOwner.signal, 1_000)
  expect(preStoppedLease.signal.reason).toBe(ownerFailure)
  preStoppedLease.release()

  const deadlineLease = operationLease(background(), null, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  expect(deadlineLease.signal.reason).toBe(deadlineExceeded)
  deadlineLease.release()

  const released = operationLease(background(), null, 1)
  released.release()
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  expect(released.signal.aborted).toBe(false)
  expect(cause(background())).toBeNull()
})

test("signal-aware wait resolves, aborts, and preserves exact Error identity", async () => {
  const active = new AbortController()
  await expect(waitForSignal(active.signal, 1)).resolves.toBeUndefined()

  const pending = new AbortController()
  const waiting = waitForSignal(pending.signal, 1_000)
  const failure = new Error("wait stopped")
  pending.abort(failure)
  await expect(waiting).rejects.toBe(failure)

  const stopped = new AbortController()
  stopped.abort(failure)
  await expect(waitForSignal(stopped.signal, 1)).rejects.toBe(failure)
  expect(signalFailure(stopped.signal, "fallback")).toBe(failure)

  const nonError = new AbortController()
  nonError.abort("invalid")
  expect(signalFailure(nonError.signal, "normalized").message).toBe("normalized")
  ignoreFailure("observed")
})
