import { expect, test } from "bun:test"
import { background, canceled, withCancel } from "@likego/context"

import { bullMqWorkerShutdownTimeout, newBullMqWorkerServer } from "../src/index"
import { newBullMqWorkerServerWithFactory, type BullMqWorkerLike } from "../src/server"
import { fakeWorker, turns } from "./helpers"

test("validates lifecycle option bounds and option functions", () => {
  expect(() => bullMqWorkerShutdownTimeout(-1)).toThrow(RangeError)
  expect(() => bullMqWorkerShutdownTimeout(Number.NaN)).toThrow(RangeError)
  expect(() => bullMqWorkerShutdownTimeout(1.5)).toThrow(RangeError)
  expect(() => bullMqWorkerShutdownTimeout(2_147_483_648)).toThrow(RangeError)
  expect(() => bullMqWorkerShutdownTimeout(0)).not.toThrow()
  expect(() => bullMqWorkerShutdownTimeout(2_147_483_647)).not.toThrow()

  const native = fakeWorker()
  expect(() =>
    Reflect.apply(newBullMqWorkerServerWithFactory, undefined, [native.factory, [null]])
  ).toThrow("option")
  expect(() => Reflect.apply(newBullMqWorkerServerWithFactory, undefined, [null])).toThrow(
    "factory"
  )
  expect(() => Reflect.apply(newBullMqWorkerServer, undefined, [null])).toThrow(
    "Worker or Worker factory"
  )
})

test("does not invoke the application factory before start or after preflight cancellation", async () => {
  const native = fakeWorker()
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  expect(native.calls).toEqual([])

  const [ctx, cancel] = withCancel(background())
  cancel()
  await expect(subject.start(ctx)).rejects.toBe(canceled)
  expect(native.calls).toEqual([])
})

test("rejects non-dormant factory Workers and closes each provisional native lifecycle", async () => {
  for (const options of [
    { autorun: true },
    { running: true },
    { closing: true },
    { queueName: "" }
  ]) {
    const native = fakeWorker(options)
    const subject = newBullMqWorkerServerWithFactory(native.factory)
    await expect(subject.start(background())).rejects.toBeInstanceOf(TypeError)
    expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
  }
})

test("aggregates provisional close failure with the factory handoff violation", async () => {
  const native = fakeWorker({ autorun: true, close: "throw" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  const failure = await subject.start(background()).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError))
    throw new Error("expected provisional cleanup aggregate")
  expect(failure.errors[0]).toMatchObject({
    message: "BullMQ Worker must be constructed with autorun: false"
  })
  expect(failure.errors[1]).toMatchObject({ message: "close threw" })
})

test("rolls back partially installed lifecycle listeners before closing a factory Worker", async () => {
  const native = fakeWorker({ install: "throw-closed" })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  await expect(subject.start(background())).rejects.toThrow("closed listener install threw")
  expect(native.calls).toContainEqual(["off", "error"])
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])

  const firstListener = fakeWorker({ install: "throw-error" })
  await expect(
    newBullMqWorkerServerWithFactory(firstListener.factory).start(background())
  ).rejects.toThrow("error listener install threw")
  expect(firstListener.calls.filter(([name]) => name === "off")).toEqual([["off", "error"]])
})

test("rejects every malformed structural testing lifecycle without inventing data-plane fields", async () => {
  const native = fakeWorker()
  const base = native.worker
  const malformed: unknown[] = [
    null,
    "worker",
    Object.freeze({ name: "queue", opts: null }),
    Object.freeze({ name: "queue", opts: true })
  ]
  for (const key of [
    "name",
    "on",
    "off",
    "waitUntilReady",
    "run",
    "pause",
    "cancelAllJobs",
    "close",
    "isRunning"
  ]) {
    const candidate: Record<string, unknown> = {
      name: base.name,
      opts: base.opts,
      on: base.on,
      off: base.off,
      waitUntilReady: base.waitUntilReady,
      run: base.run,
      pause: base.pause,
      cancelAllJobs: base.cancelAllJobs,
      close: base.close,
      isRunning: base.isRunning
    }
    Reflect.deleteProperty(candidate, key)
    malformed.push(candidate)
  }

  for (const candidate of malformed) {
    const subject = newBullMqWorkerServerWithFactory(() => candidate as BullMqWorkerLike)
    await expect(subject.start(background())).rejects.toThrow("native Worker lifecycle")
  }
})

test("a factory candidate remains one-shot after validation failure", async () => {
  const native = fakeWorker({ autorun: true })
  const subject = newBullMqWorkerServerWithFactory(native.factory)
  await expect(subject.start(background())).rejects.toThrow("autorun")
  await turns()
  await expect(subject.start(background())).rejects.toMatchObject({ status: "failed" })
})
