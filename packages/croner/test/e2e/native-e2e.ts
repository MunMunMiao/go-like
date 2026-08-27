import assert from "node:assert/strict"
import { createRequire } from "node:module"
import process from "node:process"

import { background, canceled, type Context } from "@go-like/context"
import { newCronerServer } from "@go-like/croner"
import { Cron } from "croner"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/** Creates a manually controlled Promise for native lifecycle evidence. */
function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = unavailableResolve
  let rejectValue: (error: unknown) => void = unavailableReject
  /** Captures native Promise settlement callbacks synchronously. */
  function capture(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    resolveValue = resolve
    rejectValue = reject
  }
  const promise = new Promise<T>(capture)
  return { promise, resolve: resolveValue, reject: rejectValue }
}

/** Guards impossible Deferred use before constructor callback execution. */
function unavailableResolve(_value: unknown): void {
  throw new Error("deferred resolver unavailable")
}

/** Guards impossible Deferred use before constructor callback execution. */
function unavailableReject(_error: unknown): void {
  throw new Error("deferred rejecter unavailable")
}

/** Resolves after one native timer interval. */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(function schedule(resolve) {
    setTimeout(resolve, milliseconds)
  })
}

/** Selects timer resources from Node's public active resource inventory. */
function isTimeoutResource(resource: string): boolean {
  return resource === "Timeout"
}

const baselineTimeouts = process.getActiveResourcesInfo().filter(isTimeoutResource).length
const require = createRequire(import.meta.url)
const cronerPackage = require("croner/package.json") as { readonly version: string }
assert.equal(cronerPackage.version, "10.0.1")
const unhandled: unknown[] = []
const scenarios: string[] = []
let acceptedServers = 0
let stopAttempts = 0
let terminalServers = 0
/** Records any rejection that escapes native and explicit ownership boundaries. */
function recordUnhandled(reason: unknown): void {
  unhandled.push(reason)
}
process.on("unhandledRejection", recordUnhandled)

try {
  const exhausted = deferred<void>()
  const observed: unknown[] = []
  let tickCalls = 0
  const finite: { value: Cron<Context> | null } = { value: null }
  const finiteServer = newCronerServer<Context>(function create(ctx) {
    finite.value = new Cron<Context>(
      "* * * * * *",
      {
        paused: true,
        maxRuns: 2,
        context: ctx,
        catch(error): void {
          observed.push(error)
        }
      },
      function tick(_job, callbackCtx): void {
        assert.equal(callbackCtx, ctx)
        tickCalls += 1
        if (tickCalls === 1) throw new Error("native scheduled failure")
        exhausted.resolve(undefined)
      }
    )
    return finite.value
  })
  const finiteRunning = finiteServer.start(background())
  acceptedServers += 1
  let deadline: ReturnType<typeof setTimeout> | null = null
  const timed = new Promise<never>(function startDeadline(_resolve, reject) {
    deadline = setTimeout(function timerFailed(): void {
      reject(new Error("Croner did not reach native maxRuns"))
    }, 4_000)
  })
  try {
    await Promise.race([exhausted.promise, timed])
  } finally {
    if (deadline !== null) clearTimeout(deadline)
  }
  assert.equal(tickCalls, 2)
  assert.equal(observed.length, 1)
  assert.equal(finite.value?.isRunning(), false)
  assert.equal(finite.value?.isStopped(), false)
  assert.equal(finite.value?.nextRun(), null)
  const passive = await Promise.race([
    finiteRunning.then(function terminal(): string {
      return "terminal"
    }),
    delay(0).then(function pending(): string {
      return "pending"
    })
  ])
  assert.equal(passive, "pending")
  scenarios.push("native-factory-resume-and-exhaustion-unobservable")
  stopAttempts += 1
  await finiteServer.stop(background())
  await finiteRunning
  terminalServers += 1

  const release = deferred<void>()
  const started = deferred<void>()
  const active: { value: Cron<Context> | null } = { value: null }
  const activeContext: { value: Context | null } = { value: null }
  const activeServer = newCronerServer<Context>(function create(ctx) {
    activeContext.value = ctx
    active.value = new Cron<Context>(
      "0 0 0 1 1 * 2099",
      {
        paused: true,
        context: ctx,
        catch: true
      },
      async function held(_job, callbackCtx): Promise<void> {
        assert.equal(callbackCtx, ctx)
        started.resolve(undefined)
        await release.promise
      }
    )
    return active.value
  })
  const activeRunning = activeServer.start(background())
  await Promise.resolve()
  acceptedServers += 1
  const nativeRun = active.value?.trigger()
  await started.promise
  assert.equal(active.value?.isBusy(), true)
  stopAttempts += 1
  await activeServer.stop(background())
  await activeRunning
  terminalServers += 1
  assert.equal(active.value?.isStopped(), true)
  assert.equal(active.value?.isBusy(), true)
  assert.equal(activeContext.value?.err(), canceled)
  scenarios.push("explicit-stop-does-not-fabricate-native-callback-drain")
  release.resolve(undefined)
  await nativeRun
  assert.equal(active.value?.isBusy(), false)
  await delay(50)
  await new Promise<void>(function leaveTimeoutTurn(resolve) {
    setImmediate(resolve)
  })
  assert.deepEqual(unhandled, [])
  const finalTimeouts = process.getActiveResourcesInfo().filter(isTimeoutResource).length
  assert.equal(finalTimeouts, baselineTimeouts)
  assert.equal(acceptedServers, 2)
  assert.equal(stopAttempts, 2)
  assert.equal(terminalServers, 2)
  assert.equal(acceptedServers, terminalServers)
} finally {
  process.off("unhandledRejection", recordUnhandled)
}
