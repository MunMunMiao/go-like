import { expect, test } from "bun:test"

import { deadlineExceeded, type Context } from "../../src/context/index"
import { afterStart, newApp, resources, server, stopTimeout, telemetry } from "../../src/index"
import type { Server } from "../../src/lifecycle/index"
import { newTelemetry } from "../../src/telemetry/index"
import type { TelemetryLifecycle } from "../../src/telemetry/types"

/** Settles `operation`, or reports that the real timer elapsed. */
async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs = 250
): Promise<PromiseSettledResult<T> | "test-timeout"> {
  const settled = Promise.withResolvers<PromiseSettledResult<T> | "test-timeout">()
  const timer = setTimeout(() => {
    settled.resolve("test-timeout")
  }, timeoutMs)
  operation.then(
    (value) => {
      settled.resolve({ status: "fulfilled", value })
    },
    (reason: unknown) => {
      settled.resolve({ status: "rejected", reason })
    }
  )
  try {
    return await settled.promise
  } finally {
    clearTimeout(timer)
  }
}

/** Waits on the real timer queue. Deadline timers in core use the same queue. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Returns the observed stop context, or fails the test when stop was not called. */
function requireContext(ctx: Context | null): Context {
  if (ctx === null) throw new Error("stop context was not observed")
  return ctx
}

/** Builds a bundle whose only lifecycle is the supplied stop hook. */
function telemetryWithStop(stop: TelemetryLifecycle["stop"]) {
  return newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => Promise.resolve(),
          stop
        }
      }
    ]
  })
}

/** A server whose stop blocks until `release`, after letting its own start finish. */
function blockingServer(release: Promise<void>, onStop: (ctx: Context) => void): Server {
  const started = Promise.withResolvers<void>()
  return {
    async start() {
      await started.promise
    },
    async stop(ctx) {
      onStop(ctx)
      started.resolve()
      await release
    }
  }
}

test("telemetry stop keeps a live full stopTimeout after servers exhaust the shared budget", async () => {
  const budgetMs = 80
  const exportMs = 50
  const releaseServer = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  let serverStopContext: Context | null = null
  let telemetryStopContext: Context | null = null
  let telemetryEnteredAt = 0
  let exported = false
  const app = newApp(
    telemetry(
      telemetryWithStop(async (ctx) => {
        telemetryStopContext = ctx
        telemetryEnteredAt = performance.now()
        await pause(exportMs)
        exported = true
      })
    ),
    stopTimeout(budgetMs),
    afterStart(() => {
      ready.resolve()
    }),
    server(
      blockingServer(releaseServer.promise, (ctx) => {
        serverStopContext = ctx
      })
    )
  )
  const running = app.run()

  try {
    await ready.promise
    const stopping = app.stop()
    const outcome = await settleWithin(stopping, 1_000)
    const telemetryWaitMs = telemetryEnteredAt === 0 ? 0 : performance.now() - telemetryEnteredAt
    expect(outcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    expect(requireContext(serverStopContext).err()).toBe(deadlineExceeded)
    expect(requireContext(telemetryStopContext).err()).toBeNull()
    expect(exported).toBe(true)
    expect(telemetryWaitMs).toBeGreaterThan(exportMs * 0.5)
    expect(telemetryWaitMs).toBeLessThan(budgetMs + exportMs)
    expect(await settleWithin(running, 1_000)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    releaseServer.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("a telemetry drain that never settles is bounded by about two stop budgets", async () => {
  const budgetMs = 80
  const releaseServer = Promise.withResolvers<void>()
  const releaseTelemetry = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  let serverStopAt = 0
  let telemetryStopAt = 0
  const app = newApp(
    telemetry(
      telemetryWithStop(async () => {
        telemetryStopAt = performance.now()
        await releaseTelemetry.promise
      })
    ),
    stopTimeout(budgetMs),
    afterStart(() => {
      ready.resolve()
    }),
    server(
      blockingServer(releaseServer.promise, () => {
        serverStopAt = performance.now()
      })
    )
  )
  const running = app.run()

  try {
    await ready.promise
    const startedAt = performance.now()
    const stopping = app.stop()
    const stopOutcome = await settleWithin(stopping, 2_000)
    const runOutcome = await settleWithin(running, 2_000)
    const sharedWaitMs = telemetryStopAt === 0 ? 0 : telemetryStopAt - serverStopAt
    const telemetryWaitMs = telemetryStopAt === 0 ? 0 : performance.now() - telemetryStopAt
    const totalWaitMs = performance.now() - startedAt
    expect(stopOutcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    expect(runOutcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    expect(sharedWaitMs).toBeGreaterThan(budgetMs * 0.4)
    expect(telemetryWaitMs).toBeGreaterThan(budgetMs * 0.4)
    expect(telemetryWaitMs).toBeLessThan(budgetMs * 5)
    expect(totalWaitMs).toBeGreaterThan(budgetMs * 1.2)
    expect(totalWaitMs).toBeLessThan(budgetMs * 8)
  } finally {
    releaseServer.resolve()
    releaseTelemetry.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("stopTimeout 0 leaves the shared stop and the telemetry drain unbounded", async () => {
  const releaseServer = Promise.withResolvers<void>()
  const releaseTelemetry = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const serverEntered = Promise.withResolvers<void>()
  const telemetryEntered = Promise.withResolvers<Context>()
  let serverStopContext: Context | null = null
  let exported = false
  const app = newApp(
    telemetry(
      telemetryWithStop(async (ctx) => {
        telemetryEntered.resolve(ctx)
        await releaseTelemetry.promise
        exported = true
      })
    ),
    stopTimeout(0),
    afterStart(() => {
      ready.resolve()
    }),
    server(
      blockingServer(releaseServer.promise, (ctx) => {
        serverStopContext = ctx
        serverEntered.resolve()
      })
    )
  )
  const running = app.run()

  try {
    await ready.promise
    const stopping = app.stop()
    await serverEntered.promise
    const sharedStop = requireContext(serverStopContext)
    expect(sharedStop.err()).toBeNull()
    expect(sharedStop.deadline()[1]).toBe(false)
    expect(await settleWithin(stopping, 40)).toBe("test-timeout")
    releaseServer.resolve()
    const telemetryStopContext = await telemetryEntered.promise
    expect(telemetryStopContext.err()).toBeNull()
    expect(telemetryStopContext.deadline()[1]).toBe(false)
    expect(await settleWithin(stopping, 40)).toBe("test-timeout")
    releaseTelemetry.resolve()
    await stopping
    await running
    expect(exported).toBe(true)
  } finally {
    releaseServer.resolve()
    releaseTelemetry.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("servers that exhaust the shared budget still stop every resource without further waiting", async () => {
  const budgetMs = 40
  const releaseServer = Promise.withResolvers<void>()
  const releaseResources = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const stops: string[] = []
  /** Records the stop context, then hangs so a fresh budget would be visible. */
  function hangingResource(name: string): Server {
    return {
      async start() {},
      async stop(ctx) {
        stops.push(`${name}:${ctx.err() === deadlineExceeded ? "expired" : "live"}`)
        await releaseResources.promise
      }
    }
  }
  const app = newApp(
    stopTimeout(budgetMs),
    resources(hangingResource("0"), hangingResource("1")),
    afterStart(() => {
      ready.resolve()
    }),
    server(blockingServer(releaseServer.promise, () => {}))
  )
  const running = app.run()

  try {
    await ready.promise
    const startedAt = performance.now()
    const stopping = app.stop()
    const outcome = await settleWithin(stopping, 500)
    const elapsedMs = performance.now() - startedAt
    expect(stops).toEqual(["1:expired", "0:expired"])
    expect(outcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    expect(elapsedMs).toBeLessThan(budgetMs * 6)
    expect(await settleWithin(running, 500)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    releaseServer.resolve()
    releaseResources.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})
