import { describe, expect, test } from "bun:test"

import { background, canceled, type Context, withCancelCause } from "@likego/context"
import type { Server } from "@likego/core"
import { Cron } from "croner"

import { newCronerServer } from "../src/index"
import { deferred, delay, eventually, pausedCron } from "./helpers"

describe("Croner structural Server lifecycle", () => {
  test("stops before startup without constructing native work", async () => {
    let factoryCalls = 0
    const server = newCronerServer(function create() {
      factoryCalls += 1
      return pausedCron(function noOp(): void {})
    })

    await Promise.all([server.stop(background()), server.stop(background())])
    expect(factoryCalls).toBe(0)
    await expect(server.start(background())).rejects.toThrow("already started")
  })

  test("stops an admitted startup before constructing native work", async () => {
    let factoryCalls = 0
    const server = newCronerServer(function create() {
      factoryCalls += 1
      return pausedCron(function noOp(): void {})
    })

    const running = server.start(background())
    await Promise.all([running, server.stop(background())])
    expect(factoryCalls).toBe(0)
  }, 1_000)

  test("runs through one stable Promise until explicit stop", async () => {
    const server: Server = newCronerServer(function create() {
      return pausedCron(function noOp(): void {})
    })
    const running = server.start(background())
    await Promise.resolve()
    expect(
      await Promise.race([
        running.then(function terminal(): string {
          return "terminal"
        }),
        delay(0).then(function pending(): string {
          return "pending"
        })
      ])
    ).toBe("pending")

    await Promise.all([server.stop(background()), server.stop(background()), running])
    await expect(server.start(background())).rejects.toThrow("already started")
  })

  test("stops factory-created work when the factory synchronously reenters stop", async () => {
    const job: { value: Cron | null } = { value: null }
    const stopping: { value: Promise<void> | null } = { value: null }
    const server = newCronerServer(function create() {
      job.value = pausedCron(function noOp(): void {})
      stopping.value = server.stop(background())
      return job.value
    })

    const running = server.start(background())
    await Promise.resolve()
    const requestedStop = stopping.value
    if (requestedStop === null) throw new Error("factory did not request stop")
    await Promise.all([running, requestedStop])
    expect(job.value?.isStopped()).toBe(true)
    expect(job.value?.isRunning()).toBe(false)
  }, 1_000)

  test("stops future scheduling and cancels runtime Context without pretending to drain a native callback", async () => {
    const release = deferred<void>()
    const started = deferred<void>()
    const job: { value: Cron<Context> | null } = { value: null }
    const runtime: { value: Context | null } = { value: null }
    const server = newCronerServer<Context>(function create(ctx) {
      runtime.value = ctx
      job.value = pausedCron(
        async function held(_self, callbackCtx): Promise<void> {
          expect(callbackCtx).toBe(ctx)
          started.resolve(undefined)
          await release.promise
        },
        { context: ctx, protect: false, catch: true }
      )
      return job.value
    })
    const running = server.start(background())
    await Promise.resolve()

    const active = job.value?.trigger()
    await started.promise
    expect(job.value?.isBusy()).toBe(true)
    await server.stop(background())
    await running
    expect(job.value?.isStopped()).toBe(true)
    expect(job.value?.isBusy()).toBe(true)
    expect(runtime.value?.err()).toBe(canceled)

    release.resolve(undefined)
    await active
    expect(job.value?.isBusy()).toBe(false)
  })

  test("keeps natural Croner exhaustion unobservable until explicit stop", async () => {
    const ticked = deferred<void>()
    const job: { value: Cron | null } = { value: null }
    const server = newCronerServer(function create() {
      job.value = new Cron(
        "* * * * * *",
        {
          paused: true,
          maxRuns: 1,
          catch: true
        },
        function tick(): void {
          ticked.resolve(undefined)
        }
      )
      return job.value
    })
    const running = server.start(background())

    await ticked.promise
    await eventually(function exhausted(): boolean {
      return job.value?.isRunning() === false && job.value.nextRun() === null
    })
    expect(job.value?.isStopped()).toBe(false)
    expect(
      await Promise.race([
        running.then(function terminal(): string {
          return "terminal"
        }),
        delay(0).then(function pending(): string {
          return "pending"
        })
      ])
    ).toBe("pending")
    await server.stop(background())
    await running
  })

  test("scopes a canceled stop caller to its wait while the shared owner still stops", async () => {
    const job: { value: Cron | null } = { value: null }
    const server = newCronerServer(function create() {
      job.value = pausedCron(function noOp(): void {})
      return job.value
    })
    const running = server.start(background())
    await Promise.resolve()
    const caller = withCancelCause(background())
    const failure = new Error("stop caller left")
    caller[1](failure)

    await expect(server.stop(caller[0])).rejects.toBe(failure)
    await running
    expect(job.value?.isStopped()).toBe(true)
  })

  test("aggregates reverse-order native stop failures and preserves stable terminal identity", async () => {
    const firstFailure = new Error("first stop failed")
    const secondFailure = new Error("second stop failed")
    const first = pausedCron(function noOp(): void {})
    const second = pausedCron(function noOp(): void {})
    const firstStop = first.stop.bind(first)
    const secondStop = second.stop.bind(second)
    first.stop = function failFirst(): void {
      firstStop()
      throw firstFailure
    }
    second.stop = function failSecond(): void {
      secondStop()
      throw secondFailure
    }
    const server = newCronerServer(function create() {
      return [first, second]
    })
    const running = server.start(background())
    await Promise.resolve()

    const failure: unknown = await server.stop(background()).catch(function capture(
      error: unknown
    ): unknown {
      return error
    })
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([secondFailure, firstFailure])
    await expect(running).rejects.toBe(failure)
    await expect(server.stop(background())).rejects.toBe(failure)
  })
})
