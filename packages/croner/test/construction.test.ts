import { describe, expect, test } from "bun:test"

import { background, canceled, type Context, withCancelCause } from "@go-like/context"
import { Cron } from "croner"

import { newCronerServer, type CronerFactory } from "../src/index"
import { deferred, pausedCron } from "./helpers"

describe("native Cron factory", () => {
  test("validates only the factory without constructing Croner work early", async () => {
    let calls = 0
    const factory: CronerFactory = function create(): Cron {
      calls += 1
      return pausedCron(function noOp(): void {})
    }
    const server = newCronerServer(factory)
    expect(calls).toBe(0)

    const running = server.start(background())
    await Promise.resolve()
    expect(calls).toBe(1)
    await server.stop(background())
    await running
    expect(calls).toBe(1)
  })

  test("passes an independent runtime Context first and resumes every paused native Cron", async () => {
    const runtime: { value: Context | null } = { value: null }
    const first: { value: Cron<Context> | null } = { value: null }
    const second: { value: Cron<Context> | null } = { value: null }
    const startup = withCancelCause(background())
    const server = newCronerServer<Context>(function create(ctx) {
      runtime.value = ctx
      first.value = pausedCron(
        function firstRun(_self, callbackCtx): void {
          expect(callbackCtx).toBe(ctx)
        },
        { context: ctx }
      )
      second.value = pausedCron(
        function secondRun(_self, callbackCtx): void {
          expect(callbackCtx).toBe(ctx)
        },
        { context: ctx }
      )
      return [first.value, second.value]
    })

    const running = server.start(startup[0])
    await Promise.resolve()
    expect(first.value?.isRunning()).toBe(true)
    expect(second.value?.isRunning()).toBe(true)
    startup[1](new Error("startup caller left"))
    expect(runtime.value?.err()).toBeNull()

    await server.stop(background())
    await running
    expect(first.value?.isStopped()).toBe(true)
    expect(second.value?.isStopped()).toBe(true)
    expect(runtime.value?.err()).toBe(canceled)
  })

  test("rejects empty, non-native, duplicate, already-running, and unscheduled results", async () => {
    const invalidFactories: readonly (() => unknown)[] = [
      function empty(): unknown {
        return []
      },
      function nonNative(): unknown {
        return {}
      },
      function running(): unknown {
        return new Cron("0 0 0 1 1 * 2099", function noOp(): void {})
      },
      function unscheduled(): unknown {
        return new Cron("0 0 0 1 1 * 2099", { paused: true })
      }
    ]
    for (const invalid of invalidFactories) {
      const server = newCronerServer(invalid as CronerFactory)
      await expect(server.start(background())).rejects.toBeInstanceOf(TypeError)
    }

    const duplicate = pausedCron(function noOp(): void {})
    const duplicateServer = newCronerServer(function createDuplicate() {
      return [duplicate, duplicate]
    })
    await expect(duplicateServer.start(background())).rejects.toThrow("duplicate")
    expect(duplicate.isStopped()).toBe(true)
  })

  test("rejects a busy factory result and permanently stops it during rollback", async () => {
    const release = deferred<void>()
    const busy = pausedCron(async function held(): Promise<void> {
      await release.promise
    })
    const active = busy.trigger()
    await Promise.resolve()
    expect(busy.isBusy()).toBe(true)

    await expect(
      newCronerServer(function createBusy() {
        return busy
      }).start(background())
    ).rejects.toThrow("busy")
    expect(busy.isStopped()).toBe(true)
    release.resolve(undefined)
    await active
  })

  test("retains partial factory and rollback failures across a reentrant native stop", async () => {
    const cleanupFailure = new Error("partial result cleanup failed")
    const accepted = pausedCron(function noOp(): void {})
    const nativeStop = accepted.stop.bind(accepted)
    const nestedStop: { value: Promise<unknown> | null } = { value: null }
    function capture(error: unknown): unknown {
      return error
    }
    accepted.stop = function failCleanup(): void {
      nestedStop.value = server.stop(background()).catch(capture)
      nativeStop()
      throw cleanupFailure
    }
    const server = newCronerServer(function createPartial() {
      return [accepted, {}] as unknown as readonly Cron[]
    })

    const failure: unknown = await server.start(background()).catch(capture)
    expect(failure).toBeInstanceOf(AggregateError)
    const aggregate = failure as AggregateError
    expect(aggregate.errors).toHaveLength(2)
    expect(aggregate.errors[0]).toBeInstanceOf(TypeError)
    expect(aggregate.errors[1]).toBe(cleanupFailure)
    const nestedFailure = nestedStop.value
    if (nestedFailure === null) throw new Error("native stop did not reenter the Server")
    expect(await nestedFailure).toBe(failure)
    expect(accepted.isStopped()).toBe(true)
  })

  test("rejects native Cron results that were already permanently stopped", async () => {
    const stopped = pausedCron(function noOp(): void {})
    stopped.stop()

    await expect(
      newCronerServer(function createStopped() {
        return stopped
      }).start(background())
    ).rejects.toThrow("already stopped")
  })

  test("rejects a paused native Cron when native resume declines startup", async () => {
    const declined = pausedCron(function noOp(): void {})
    declined.resume = function declineResume(): boolean {
      return false
    }

    await expect(
      newCronerServer(function createDeclined() {
        return declined
      }).start(background())
    ).rejects.toThrow("could not resume")
    expect(declined.isStopped()).toBe(true)
  })

  test("rolls back every returned native Cron in reverse order when resume fails", async () => {
    const calls: string[] = []
    const first = pausedCron(function noOp(): void {})
    const second = pausedCron(function noOp(): void {})
    const firstStop = first.stop.bind(first)
    const secondStop = second.stop.bind(second)
    first.stop = function stopFirst(): void {
      calls.push("first")
      firstStop()
    }
    second.stop = function stopSecond(): void {
      calls.push("second")
      secondStop()
    }
    second.resume = function failResume(): boolean {
      throw new Error("resume failed")
    }

    const server = newCronerServer(function createBoth() {
      return [first, second]
    })
    await expect(server.start(background())).rejects.toThrow("resume failed")
    expect(calls).toEqual(["second", "first"])
    expect(first.isStopped()).toBe(true)
    expect(second.isStopped()).toBe(true)
  })

  test("halts resume admission when the first native job synchronously reenters stop", async () => {
    const first = pausedCron(function noOp(): void {})
    const second = pausedCron(function noOp(): void {})
    const firstResume = first.resume.bind(first)
    const secondResume = second.resume.bind(second)
    const stopping: { value: Promise<void> | null } = { value: null }
    let secondResumeCalls = 0
    const server = newCronerServer(function createBoth() {
      return [first, second]
    })
    first.resume = function resumeAndStop(): boolean {
      stopping.value = server.stop(background())
      return firstResume()
    }
    second.resume = function countResume(): boolean {
      secondResumeCalls += 1
      return secondResume()
    }

    const running = server.start(background())
    await Promise.resolve()
    try {
      const requestedStop = stopping.value
      if (requestedStop === null) throw new Error("native resume did not reenter the Server")
      const outcome = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(function timedOut(): void {
          resolve("timeout")
        }, 25)
        void Promise.all([running, requestedStop]).then(
          function settled(): void {
            clearTimeout(timeout)
            resolve("settled")
          },
          function failed(error: unknown): void {
            clearTimeout(timeout)
            reject(error)
          }
        )
      })

      expect(outcome).toBe("settled")
      expect(secondResumeCalls).toBe(0)
      expect(first.isStopped()).toBe(true)
      expect(first.isRunning()).toBe(false)
      expect(second.isStopped()).toBe(true)
      expect(second.isRunning()).toBe(false)
    } finally {
      first.stop()
      second.stop()
    }
  }, 1_000)

  test("shares a reentrant native stop failure without leaving factory-created work running", async () => {
    const failure = new Error("reentrant native stop failed")
    const job: { value: Cron | null } = { value: null }
    const stopping: { value: Promise<void> | null } = { value: null }
    const server = newCronerServer(function create() {
      const created = pausedCron(function noOp(): void {})
      const nativeStop = created.stop.bind(created)
      created.stop = function failStop(): void {
        nativeStop()
        throw failure
      }
      job.value = created
      stopping.value = server.stop(background())
      return created
    })

    const running = server.start(background())
    await Promise.resolve()
    const requestedStop = stopping.value
    if (requestedStop === null) throw new Error("factory did not request stop")
    function capture(error: unknown): unknown {
      return error
    }
    const [startFailure, stopFailure] = await Promise.all([
      running.catch(capture),
      requestedStop.catch(capture)
    ])

    expect(startFailure).toBe(failure)
    expect(stopFailure).toBe(failure)
    expect(job.value?.isStopped()).toBe(true)
    expect(job.value?.isRunning()).toBe(false)
  }, 1_000)

  test("preserves a canceled startup cause and consumes the one-shot server", async () => {
    const failure = new Error("startup canceled")
    const startup = withCancelCause(background())
    startup[1](failure)
    let factoryCalls = 0
    const server = newCronerServer(function create() {
      factoryCalls += 1
      return pausedCron(function noOp(): void {})
    })

    await expect(server.start(startup[0])).rejects.toBe(failure)
    expect(factoryCalls).toBe(0)
    await expect(server.start(background())).rejects.toThrow("already started")
  })
})
