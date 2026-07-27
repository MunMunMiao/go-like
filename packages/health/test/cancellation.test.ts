import { expect, test } from "bun:test"

import { background, withCancelCause } from "@likego/context"
import { newProbeRegistry } from "../src/index"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("zero timeout is already canceled but still invokes and observes the probe", async () => {
  const registry = newProbeRegistry()
  let invoked = 0
  let rejectLate = (error: Error) => {}
  registry.register(
    "live",
    "zero",
    () => {
      invoked += 1
      return new Promise<void>((_resolve, reject) => {
        rejectLate = reject
      })
    },
    { timeoutMs: 0 }
  )

  const report = await registry.check(background(), "live")
  rejectLate(new Error("late private failure"))
  await sleep(5)

  expect(invoked).toBe(1)
  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBeInstanceOf(Error)
})

test("independent timeout budgets do not block later successful checks", async () => {
  const registry = newProbeRegistry()
  registry.register(
    "ready",
    "slow",
    async () => {
      await sleep(30)
    },
    { timeoutMs: 1 }
  )
  registry.register("ready", "fast", () => {}, { timeoutMs: 100 })

  const report = await registry.check(background(), "ready")
  expect(report.checks.map((check) => check.ok)).toEqual([false, true])
})

test("operation failure wins before later cleanup cancellation", async () => {
  const registry = newProbeRegistry()
  const failure = new Error("operation")
  registry.register(
    "ready",
    "fail-fast",
    async () => {
      throw failure
    },
    { timeoutMs: 100 }
  )

  const report = await registry.check(background(), "ready")
  expect(report.checks[0]?.error).toBe(failure)
})

test("cancellation admitted inside a synchronously returning probe wins", async () => {
  const registry = newProbeRegistry()
  const cancellationCause = new Error("cancel during probe")
  const [parent, cancel] = withCancelCause(background())
  registry.register("ready", "sync-return", () => {
    cancel(cancellationCause)
  })

  const report = await registry.check(parent, "ready")

  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBe(cancellationCause)
})

test("cancellation admitted before a synchronous throw wins", async () => {
  const registry = newProbeRegistry()
  const cancellationCause = new Error("cancel before throw")
  const operationFailure = new Error("throw after cancellation")
  const [parent, cancel] = withCancelCause(background())
  registry.register("ready", "sync-throw", () => {
    cancel(cancellationCause)
    throw operationFailure
  })

  const report = await registry.check(parent, "ready")

  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBe(cancellationCause)
})

test("an admitted cancellation beats an already queued asynchronous operation handler", async () => {
  const registry = newProbeRegistry()
  const cancellationCause = new Error("cancel queued operation")
  const [parent, cancel] = withCancelCause(background())
  registry.register("ready", "queued", () => Promise.resolve())

  const checking = registry.check(parent, "ready")
  cancel(cancellationCause)
  const report = await checking

  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBe(cancellationCause)
})

test("cancellation inspection throws settle only the affected probe result", async () => {
  const registry = newProbeRegistry()
  const cancellationCause = new Error("cancel for inspection")
  const inspectionFailure = new Error("cancellation inspection failed")
  const [parent, cancel] = withCancelCause(background())
  const originalGet = WeakMap.prototype.get
  const originalQueueMicrotask = globalThis.queueMicrotask
  let childToFail: object | null = null
  let escaped: unknown = null

  registry.register("ready", "inspection", (ctx) => {
    childToFail = ctx
    WeakMap.prototype.get = function getWithInspectionFailure(
      this: WeakMap<object, unknown>,
      key: object
    ): unknown {
      if (key === childToFail) throw inspectionFailure
      return originalGet.call(this, key)
    } as typeof WeakMap.prototype.get
    cancel(cancellationCause)
    return new Promise<void>(() => {})
  })

  globalThis.queueMicrotask = (callback) => {
    originalQueueMicrotask(() => {
      try {
        callback()
      } catch (error) {
        escaped = error
      }
    })
  }

  try {
    const report = await Promise.race([registry.check(parent, "ready"), sleep(50).then(() => null)])

    expect(report).not.toBeNull()
    expect(report?.ok).toBe(false)
    expect(report?.checks[0]?.error).toBe(inspectionFailure)
    expect(escaped).toBeNull()
  } finally {
    WeakMap.prototype.get = originalGet
    globalThis.queueMicrotask = originalQueueMicrotask
  }
})

test("throwing structural Context cleanup cannot replace an admitted operation result", async () => {
  const registry = newProbeRegistry()
  const cleanupFailure = new Error("parent listener cleanup failed")
  let removals = 0
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      removals += 1
      throw cleanupFailure
    }
  }
  const parent = {
    deadline: () => [new Date(0), false] as const,
    done: () => signal as never,
    err: () => null,
    value: () => null
  }
  registry.register("ready", "cleanup", () => {})

  const report = await registry.check(parent, "ready")

  expect(report.ok).toBe(true)
  expect(report.checks[0]).toMatchObject({ name: "cleanup", ok: true, error: null })
  expect(removals).toBe(1)
})

test("throwing cancellation listener registration is isolated into the probe result", async () => {
  const registry = newProbeRegistry()
  const original = AbortSignal.prototype.addEventListener
  registry.register(
    "ready",
    "listener",
    async () => {
      await new Promise<void>(() => {})
    },
    { timeoutMs: 100 }
  )
  AbortSignal.prototype.addEventListener = function addEventListenerThrowing(): void {
    throw new Error("listener unavailable")
  }
  try {
    const report = await registry.check(background(), "ready")
    expect(report.ok).toBe(false)
    expect(report.checks[0]?.error?.message).toBe("listener unavailable")
  } finally {
    AbortSignal.prototype.addEventListener = original
  }
})

test("throwing cancellation listener registration still observes late probe rejection", async () => {
  const registry = newProbeRegistry()
  const original = AbortSignal.prototype.addEventListener
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  let rejectLate: (error: Error) => void = () => {}
  registry.register(
    "ready",
    "listener",
    () => {
      return new Promise<void>((_resolve, reject) => {
        rejectLate = reject
      })
    },
    { timeoutMs: 100 }
  )
  AbortSignal.prototype.addEventListener = function addEventListenerThrowing(): void {
    throw new Error("listener unavailable")
  }
  try {
    const report = await registry.check(background(), "ready")
    rejectLate(new Error("late private failure"))
    await sleep(10)
    expect(report.ok).toBe(false)
    expect(unhandled).toEqual([])
  } finally {
    AbortSignal.prototype.addEventListener = original
    process.off("unhandledRejection", onUnhandled)
  }
})
