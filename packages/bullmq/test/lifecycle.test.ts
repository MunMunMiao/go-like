import { expect, test } from "bun:test"
import { background, canceled, withCancel } from "@go-like/context"
import { newApp, server as registerServer, stopTimeout as appStopTimeout } from "@go-like/core"

import { bullMqWorkerShutdownTimeout } from "../src/index"
import { newBullMqWorkerServerWithFactory } from "../src/server"
import { fakeWorker, turns } from "./helpers"

/** Reports whether one operation reaches either terminal state within a test-only bound. */
async function settlesWithin(operation: Promise<unknown>, timeoutMs = 250): Promise<boolean> {
  return await Promise.race([
    operation.then(
      () => true,
      () => true
    ),
    Bun.sleep(timeoutMs).then(() => false)
  ])
}

/** Waits until startup has entered the native Worker run loop. */
async function waitForRun(native: ReturnType<typeof fakeWorker>): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (native.calls.some(([name]) => name === "run")) return
    await Promise.resolve()
  }
  throw new Error("BullMQ test Worker did not enter run")
}

/** Waits until one named native lifecycle call has been observed. */
async function waitForCall(native: ReturnType<typeof fakeWorker>, callName: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (native.calls.some(([name]) => name === callName)) return
    await Promise.resolve()
  }
  throw new Error(`BullMQ test Worker did not call ${callName}`)
}

test("creates lazily, waits for readiness, starts run manually, and blocks for runtime", async () => {
  const native = fakeWorker({ ready: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  expect(native.calls).toEqual([])

  const starting = subject.start(background())
  await turns()
  expect(native.calls.slice(0, 5)).toEqual([
    ["factory"],
    ["on", "error"],
    ["on", "closed"],
    ["waitUntilReady"],
    ["on", "closed"]
  ])
  expect(native.calls).not.toContainEqual(["run"])

  native.resolveReady()
  await turns()
  expect(native.calls).toContainEqual(["run"])
  await subject.stop(background())
  await starting
})

test("keeps running-period native errors observational and records drain-period errors", async () => {
  const native = fakeWorker({ close: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  const running = subject.start(background())
  await waitForRun(native)
  let terminal = false
  void running.then(
    () => {
      terminal = true
    },
    () => {
      terminal = true
    }
  )

  native.error(new Error("running outage"))
  await turns()
  expect(terminal).toBeFalse()

  const stopping = subject.stop(background())
  await turns()
  const closeFailure = new Error("drain connection failure")
  native.error(closeFailure)
  native.error(closeFailure)
  native.resolveClose()
  await expect(stopping).rejects.toBe(closeFailure)
  await expect(running).rejects.toBe(closeFailure)
})

test("converts passive run resolution, rejection, and synchronous throw into unexpected exit", async () => {
  const resolvedNative = fakeWorker()
  const resolvedServer = newBullMqWorkerServerWithFactory(resolvedNative.factory)
  const resolvedRunning = resolvedServer.start(background())
  await waitForRun(resolvedNative)
  resolvedNative.resolveRun()
  await expect(resolvedRunning).rejects.toMatchObject({
    name: "BullMqUnexpectedExitError",
    code: "GO_LIKE_BULLMQ_UNEXPECTED_EXIT",
    queueName: "email",
    cause: null
  })
  expect(resolvedNative.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
  expect(resolvedNative.calls.filter(([name]) => name === "cancelAllJobs")).toHaveLength(1)

  const rejectedNative = fakeWorker()
  const runFailure = new Error("run failed")
  const rejectedServer = newBullMqWorkerServerWithFactory(rejectedNative.factory)
  const rejectedRunning = rejectedServer.start(background())
  await waitForRun(rejectedNative)
  rejectedNative.rejectRun(runFailure)
  const rejectedTerminal = await rejectedRunning.catch((error: unknown) => error)
  expect(rejectedTerminal).toMatchObject({ name: "BullMqUnexpectedExitError", cause: runFailure })
  if (!(rejectedTerminal instanceof Error)) throw new Error("expected unexpected exit")
  expect(rejectedTerminal.cause).toBe(runFailure)

  const thrownNative = fakeWorker({ run: "throw" })
  const thrownServer = newBullMqWorkerServerWithFactory(thrownNative.factory)
  const thrownRunning = thrownServer.start(background())
  await expect(thrownRunning).rejects.toMatchObject({
    name: "BullMqUnexpectedExitError",
    cause: { message: "run threw" }
  })
})

test("converts passive closed into unexpected exit without closing twice", async () => {
  const native = fakeWorker()
  const server = newBullMqWorkerServerWithFactory(native.factory)
  const running = server.start(background())
  await waitForRun(native)
  native.closed()

  await expect(running).rejects.toMatchObject({
    name: "BullMqUnexpectedExitError",
    cause: null
  })
  expect(native.calls.filter(([name]) => name === "close")).toEqual([])
  expect(native.calls.filter(([name]) => name === "cancelAllJobs")).toHaveLength(1)
  expect(native.calls).toContainEqual(["off", "error"])
})

test("shares one graceful pause and close while caller cancellation abandons only its waiter", async () => {
  const native = fakeWorker({ pause: "hold" })
  const server = newBullMqWorkerServerWithFactory(native.factory)
  const running = server.start(background())
  await waitForRun(native)
  const [ctx, cancel] = withCancel(background())
  const first = server.stop(ctx)
  await turns()

  expect(native.calls.filter(([name]) => name === "pause")).toEqual([["pause", false]])
  expect(native.calls.filter(([name]) => name === "close")).toEqual([])
  expect(native.calls.filter(([name]) => name === "cancelAllJobs")).toEqual([])
  cancel()
  await expect(first).rejects.toBe(canceled)

  const second = server.stop(background())
  native.resolvePause()
  await second
  await server.stop(background())
  await running
  expect(native.calls.filter(([name]) => name === "pause")).toHaveLength(1)
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
  expect(native.calls.filter(([name]) => name === "cancelAllJobs")).toEqual([])
})

test("force timeout requests native job cancellation but preserves the pending native terminal", async () => {
  const native = fakeWorker({ pause: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory, [bullMqWorkerShutdownTimeout(0)])
  const running = subject.start(background())
  await waitForRun(native)

  const failure = await subject.stop(background()).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    name: "BullMqWorkerShutdownTimeoutError",
    code: "GO_LIKE_BULLMQ_WORKER_SHUTDOWN_TIMEOUT",
    queueName: "email",
    timeoutMs: 0
  })
  expect(native.calls.filter(([name]) => name === "pause")).toEqual([["pause", false]])
  const cancellationCalls = native.calls.filter(([name]) => name === "cancelAllJobs")
  expect(cancellationCalls).toHaveLength(1)
  expect(cancellationCalls[0]?.[1]).toContain("exceeded shutdown timeout")
  expect(native.calls.filter(([name]) => name === "close")).toEqual([])
  expect(await settlesWithin(running, 20)).toBeFalse()

  native.resolvePause()
  await expect(running).rejects.toBe(failure)
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
})

test("bounds a hanging close without fabricating the closed event", async () => {
  const native = fakeWorker({ close: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory, [
    bullMqWorkerShutdownTimeout(10)
  ])
  const running = subject.start(background())
  await waitForRun(native)
  const stopping = subject.stop(background())

  expect(await settlesWithin(stopping)).toBeTrue()
  const ownerFailure = await stopping.catch((error: unknown) => error)
  expect(ownerFailure).toMatchObject({
    code: "GO_LIKE_BULLMQ_WORKER_SHUTDOWN_TIMEOUT",
    timeoutMs: 10
  })
  expect(await settlesWithin(running, 20)).toBeFalse()

  const lateEvent = new Error("late close event")
  native.error(lateEvent)
  const closeFailure = new Error("late close rejection")
  native.rejectClose(closeFailure)
  await turns()
  expect(await settlesWithin(running, 20)).toBeFalse()
  native.closed()
  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  if (!(terminal instanceof AggregateError)) throw new Error("expected terminal aggregate")
  expect(terminal.errors).toContain(closeFailure)
  expect(terminal.errors).toContain(lateEvent)
  expect(terminal.errors).toContain(ownerFailure)
})

test("counts synchronous pause and close work inside the provider boundary", async () => {
  for (const blocking of ["pause", "close"] as const) {
    const native =
      blocking === "pause" ? fakeWorker({ pause: "block" }) : fakeWorker({ close: "block" })
    const server = newBullMqWorkerServerWithFactory(native.factory, [
      bullMqWorkerShutdownTimeout(10)
    ])
    const running = server.start(background())
    await waitForRun(native)
    const started = performance.now()
    const failure = await server.stop(background()).catch((error: unknown) => error)

    expect(performance.now() - started).toBeGreaterThanOrEqual(30)
    expect(failure).toMatchObject({
      code: "GO_LIKE_BULLMQ_WORKER_SHUTDOWN_TIMEOUT",
      timeoutMs: 10
    })
    expect(native.calls.filter(([name]) => name === "cancelAllJobs")).toHaveLength(1)
    expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
    await expect(running).rejects.toBe(failure)
  }
})

test("preserves synchronous pause and active-cancellation failures", async () => {
  const pauseNative = fakeWorker({ pause: "throw" })
  const pauseServer = newBullMqWorkerServerWithFactory(pauseNative.factory)
  const pauseRunning = pauseServer.start(background())
  await waitForRun(pauseNative)
  await expect(pauseServer.stop(background())).rejects.toThrow("pause threw")
  expect(pauseNative.calls.filter(([name]) => name === "cancelAllJobs")).toEqual([
    ["cancelAllJobs", "pause threw"]
  ])
  await expect(pauseRunning).rejects.toThrow("pause threw")

  const cancelNative = fakeWorker({ pause: "hold", cancel: "throw" })
  const cancelServer = newBullMqWorkerServerWithFactory(cancelNative.factory, [
    bullMqWorkerShutdownTimeout(0)
  ])
  const cancelRunning = cancelServer.start(background())
  await waitForRun(cancelNative)
  const failure = await cancelServer.stop(background()).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("expected cancellation aggregate")
  expect(failure.errors[0]).toMatchObject({
    code: "GO_LIKE_BULLMQ_WORKER_SHUTDOWN_TIMEOUT"
  })
  expect(failure.errors[1]).toMatchObject({ message: "cancelAllJobs threw" })
  expect(await settlesWithin(cancelRunning, 20)).toBeFalse()
  cancelNative.resolvePause()
  const terminalFailure = await cancelRunning.catch((error: unknown) => error)
  expect(terminalFailure).toBeInstanceOf(AggregateError)
})

test("forces native jobs before close when asynchronous pause rejects", async () => {
  const native = fakeWorker({ pause: "hold" })
  const server = newBullMqWorkerServerWithFactory(native.factory)
  const running = server.start(background())
  await waitForRun(native)
  const stopping = server.stop(background())
  const pauseFailure = new Error("pause transport failed")

  native.rejectPause(pauseFailure)
  await expect(stopping).rejects.toBe(pauseFailure)
  expect(
    native.calls.filter(
      ([name]) => name === "pause" || name === "cancelAllJobs" || name === "close"
    )
  ).toEqual([
    ["pause", false],
    ["cancelAllJobs", "pause transport failed"],
    ["close", true]
  ])
  await expect(running).rejects.toBe(pauseFailure)
})

test("aggregates pause, emitted close, and close rejection failures in order", async () => {
  const native = fakeWorker({ pause: "hold", close: "hold" })
  const server = newBullMqWorkerServerWithFactory(native.factory)
  const running = server.start(background())
  await waitForRun(native)
  const stopping = server.stop(background())
  const pauseFailure = new Error("pause failed")
  native.rejectPause(pauseFailure)
  await waitForCall(native, "close")
  const emittedFailure = new Error("close emitted error")
  const closeFailure = new Error("close rejected")
  native.error(emittedFailure)
  native.closed()
  native.rejectClose(closeFailure)

  const failure = await stopping.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("expected aggregate drain failure")
  expect(failure.errors).toEqual([pauseFailure, emittedFailure, closeFailure])
  const terminal = await running.catch((error: unknown) => error)
  expect(terminal).toBeInstanceOf(AggregateError)
  if (!(terminal instanceof AggregateError)) throw new Error("expected terminal aggregate")
  expect(terminal.errors).toEqual([pauseFailure, emittedFailure, closeFailure])
})

test("cleans an accepted Worker and preserves startup Error identity", async () => {
  const native = fakeWorker({ ready: "hold", close: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  const starting = subject.start(background())
  await turns(8)
  expect(native.calls).toContainEqual(["waitUntilReady"])
  const startupFailure = new Error("ready failed")
  native.rejectReady(startupFailure)
  await turns()
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
  native.resolveClose()

  await expect(starting).rejects.toBe(startupFailure)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
})

test("startup cancellation after transfer closes the Worker", async () => {
  const native = fakeWorker({ ready: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  const [ctx, cancel] = withCancel(background())
  const starting = subject.start(ctx)
  await turns()
  native.error(new Error("redis unavailable"))
  cancel()

  await expect(starting).rejects.toBe(canceled)
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
})

test("bounds startup rollback without claiming native terminal", async () => {
  const native = fakeWorker({ ready: "hold", close: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory, [
    bullMqWorkerShutdownTimeout(10)
  ])
  const [ctx, cancel] = withCancel(background())
  const starting = subject.start(ctx)
  await turns()
  cancel()

  expect(await settlesWithin(starting)).toBeTrue()
  const failure = await starting.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("expected startup cleanup aggregate")
  expect(failure.errors[0]).toBe(canceled)
  expect(failure.errors[1]).toMatchObject({
    code: "GO_LIKE_BULLMQ_WORKER_SHUTDOWN_TIMEOUT"
  })
  expect(native.calls.filter(([name]) => name === "cancelAllJobs")).toEqual([])

  native.rejectClose(new Error("late startup close rejection"))
  native.closed()
  await turns()
})

test("closed before readiness rejects startup as unexpected exit", async () => {
  const native = fakeWorker({ ready: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  const starting = subject.start(background())
  await turns()
  native.closed()

  await expect(starting).rejects.toMatchObject({
    name: "BullMqUnexpectedExitError",
    queueName: "email"
  })
  expect(native.calls.filter(([name]) => name === "close")).toEqual([])
})

test("is one-shot after success and factory failure", async () => {
  const native = fakeWorker()
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  const running = subject.start(background())
  await waitForRun(native)
  await expect(subject.start(background())).rejects.toMatchObject({ status: "running" })
  await subject.stop(background())
  await running
  await expect(subject.start(background())).rejects.toMatchObject({ status: "stopped" })

  const factoryFailure = new Error("factory failed")
  const failed = newBullMqWorkerServerWithFactory(() => {
    throw factoryFailure
  })
  await expect(failed.start(background())).rejects.toBe(factoryFailure)
})

test("lets App bound a provider shutdown that never reaches native terminal", async () => {
  const native = fakeWorker({ close: "hold" })
  const subject = newBullMqWorkerServerWithFactory(native.factory, [bullMqWorkerShutdownTimeout(0)])
  const app = newApp(registerServer(subject), appStopTimeout(20))
  const running = app.run()
  void running.catch(() => {})
  await waitForRun(native)

  await expect(app.stop()).rejects.toBeInstanceOf(Error)
  native.resolveClose()
  await expect(running).rejects.toBeInstanceOf(Error)
})
