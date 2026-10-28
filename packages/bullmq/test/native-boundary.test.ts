import { expect, test } from "bun:test"
import { background, canceled, withCancel } from "@go-like/context"
import { Worker } from "bullmq"

import { newBullMqWorkerServer } from "../src/index"
import { fakeWorker, turns } from "./helpers"

/** Returns deterministic unreachable Redis options for construction-only tests. */
function unavailableRedis() {
  return {
    host: "127.0.0.1",
    port: 1,
    connectTimeout: 25,
    maxRetriesPerRequest: null,
    retryStrategy: () => null
  }
}

test("accepts an official application-created Worker without touching it before canceled start", async () => {
  const worker = new Worker(`native-direct-${crypto.randomUUID()}`, async () => undefined, {
    connection: unavailableRedis(),
    autorun: false,
    skipWaitingForReady: true
  })
  worker.on("error", () => {})
  try {
    const subject = newBullMqWorkerServer(worker)
    const [ctx, cancel] = withCancel(background())
    cancel()
    await expect(subject.start(ctx)).rejects.toBe(canceled)
    expect(worker.closing).toBeUndefined()
  } finally {
    await worker.close(true)
  }
})

test("runs the direct official Worker overload without wrapping its lifecycle", async () => {
  const native = fakeWorker()
  Object.setPrototypeOf(native.worker, Worker.prototype)
  const subject = Reflect.apply(newBullMqWorkerServer, undefined, [native.worker])
  const running = subject.start(background())
  await turns()
  expect(native.calls[0]).toEqual(["on", "error"])
  expect(native.calls).not.toContainEqual(["factory"])
  await subject.stop(background())
  await running
})

test("does not close a direct Worker when startup cancellation wins before acceptance", async () => {
  const native = fakeWorker({ ready: "hold" })
  Object.setPrototypeOf(native.worker, Worker.prototype)
  const subject = Reflect.apply(newBullMqWorkerServer, undefined, [native.worker])
  const [ctx, cancel] = withCancel(background())
  const starting = subject.start(ctx)
  await turns()

  cancel()

  await expect(starting).rejects.toBe(canceled)
  expect(native.calls.filter(([name]) => name === "close")).toEqual([])
  const removals = native.calls.filter(([name]) => name === "off")
  expect(removals).toContainEqual(["off", "error"])
  expect(removals).toContainEqual(["off", "closed"])
})

test("does not close a direct Worker when native readiness fails before acceptance", async () => {
  const native = fakeWorker({ ready: "hold" })
  Object.setPrototypeOf(native.worker, Worker.prototype)
  const subject = Reflect.apply(newBullMqWorkerServer, undefined, [native.worker])
  const starting = subject.start(background())
  await turns()
  const failure = new Error("direct readiness failed")

  native.rejectReady(failure)

  await expect(starting).rejects.toBe(failure)
  expect(native.calls.filter(([name]) => name === "close")).toEqual([])
  const removals = native.calls.filter(([name]) => name === "off")
  expect(removals).toContainEqual(["off", "error"])
  expect(removals).toContainEqual(["off", "closed"])
})

test("public factory rejects a non-official structural Worker and closes the provisional value", async () => {
  const native = fakeWorker()
  const subject = Reflect.apply(newBullMqWorkerServer, undefined, [() => native.worker])
  await expect(subject.start(background())).rejects.toThrow("official Worker")
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
})

test("public factory enforces autorun false on an official Worker it then rolls back", async () => {
  const native = fakeWorker({ autorun: true })
  Object.setPrototypeOf(native.worker, Worker.prototype)
  const subject = Reflect.apply(newBullMqWorkerServer, undefined, [() => native.worker])

  await expect(subject.start(background())).rejects.toThrow("autorun: false")
  expect(native.calls.filter(([name]) => name === "close")).toEqual([["close", true]])
})
