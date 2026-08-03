import { expect, test } from "bun:test"
import vm from "node:vm"

import { background, canceled, withCancelCause } from "@likego/context"
import { newProbeRegistry, type ProbeRegistry } from "../src/index"

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

/** Registers and retires one probe while retaining its public unregister handle. */
function retiredProbe(registry: ProbeRegistry): {
  readonly reference: WeakRef<{ readonly x: number }>
  readonly unregister: () => boolean
} {
  const token = { x: 1 }
  const reference = new WeakRef(token)
  const unregister = registry.register("live", "retired", () => {
    if (token.x !== 1) throw new Error("retired probe token changed")
  })
  expect(unregister()).toBe(true)
  return Object.freeze({ reference, unregister })
}

test("empty liveness passes while empty readiness fails closed", async () => {
  const registry = newProbeRegistry()

  expect(await registry.check(background(), "live")).toEqual({
    kind: "live",
    ok: true,
    checks: []
  })
  expect(await registry.check(background(), "ready")).toEqual({
    kind: "ready",
    ok: false,
    checks: []
  })
})

test("register validates inputs before mutation and snapshots option getters once", async () => {
  const registry = newProbeRegistry()
  let reads = 0
  const options = {
    get timeoutMs() {
      reads += 1
      return 5
    }
  }

  expect(() => registry.register("live", "bad name", () => {})).toThrow(TypeError)
  expect(() => registry.register("other" as "live", "ok", () => {})).toThrow(TypeError)
  expect(() => registry.register("live", "ok", "nope" as never)).toThrow(TypeError)
  expect(() => registry.register("live", "ok", () => {}, { timeoutMs: -1 })).toThrow(RangeError)
  expect(() =>
    registry.register("live", "null-timeout", () => {}, { timeoutMs: null as never })
  ).toThrow(RangeError)
  expect(await registry.check(background(), "live")).toMatchObject({ ok: true, checks: [] })

  registry.register("live", "ok", () => {}, options)
  expect(reads).toBe(1)
  expect(await registry.check(background(), "live")).toMatchObject({ ok: true })
})

test("duplicates are kind-local, unregister is idempotent, and re-registration appends", async () => {
  const registry = newProbeRegistry()
  const unregisterA = registry.register("live", "same", () => {})
  registry.register("ready", "same", () => {})
  expect(() => registry.register("live", "same", () => {})).toThrow(TypeError)

  expect(unregisterA()).toBe(true)
  expect(unregisterA()).toBe(false)
  registry.register("live", "first", () => {})
  registry.register("live", "same", () => {})

  const report = await registry.check(background(), "live")
  expect(report.checks.map((check) => check.name)).toEqual(["first", "same"])
})

test("unregister releases a retired probe closure while the registry remains live", async () => {
  const registry = newProbeRegistry()
  const retired = retiredProbe(registry)

  for (let attempt = 0; attempt < 20 && retired.reference.deref() !== undefined; attempt += 1) {
    await Bun.sleep(0)
    Bun.gc(true)
    await Bun.sleep(0)
  }

  expect(retired.reference.deref()).toBeUndefined()
  expect(retired.unregister()).toBe(false)
  expect(await registry.check(background(), "live")).toMatchObject({ ok: true, checks: [] })
})

test("check snapshots registrations, starts probes concurrently, and reports in registration order", async () => {
  const registry = newProbeRegistry()
  const events: string[] = []
  let releaseFirst = () => {}
  const firstStarted = new Promise<void>((resolve) => {
    registry.register("ready", "first", async () => {
      events.push("first-start")
      resolve()
      await new Promise<void>((release) => {
        releaseFirst = release
      })
      events.push("first-end")
    })
  })
  registry.register("ready", "second", () => {
    events.push("second-start")
  })

  const inFlight = registry.check(background(), "ready")
  await firstStarted
  const unregisterLate = registry.register("ready", "late", () => {})
  expect(unregisterLate()).toBe(true)
  await tick()
  expect(events).toEqual(["first-start", "second-start"])
  releaseFirst()

  const report = await inFlight
  expect(events).toEqual(["first-start", "second-start", "first-end"])
  expect(report.checks.map((check) => check.name)).toEqual(["first", "second"])
})

test("probe failures are isolated, normalized, identity-preserving, and frozen", async () => {
  const registry = newProbeRegistry()
  const thrown = new Error("sync")
  registry.register("live", "sync", () => {
    throw thrown
  })
  registry.register("live", "reject", async () => {
    throw "raw"
  })
  registry.register("live", "ok", () => {})

  const first = await registry.check(background(), "live")
  const second = await registry.check(background(), "live")

  expect(first.ok).toBe(false)
  expect(first.checks[0]?.error).toBe(thrown)
  expect(first.checks[1]?.error?.message).toBe('probe "reject" rejected with a non-Error value')
  expect(first.checks[1]?.error?.cause).toBe("raw")
  expect(Object.isFrozen(first.checks[1]?.error)).toBe(true)
  expect(first.checks[2]).toMatchObject({ name: "ok", ok: true, error: null })
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first.checks)).toBe(true)
  expect(Object.isFrozen(first.checks[0])).toBe(true)
  expect(first).not.toBe(second)
  expect(first.checks).not.toBe(second.checks)
})

test("a hostile thenable that throws while subscribing becomes only that probe failure", async () => {
  const registry = newProbeRegistry()
  const failure = new Error("then subscription failed")
  registry.register(
    "ready",
    "hostile",
    () =>
      ({
        then() {
          throw failure
        }
      }) as never
  )
  registry.register("ready", "healthy", () => {})

  const report = await registry.check(background(), "ready")

  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBe(failure)
  expect(report.checks[1]).toMatchObject({ name: "healthy", ok: true, error: null })
})

test("reports never reject for individual probe failures", async () => {
  const registry = newProbeRegistry()

  registry.register("ready", "failure", () => {
    throw new Error("private")
  })
  await expect(registry.check(background(), "ready")).resolves.toMatchObject({ ok: false })
})

test("child construction failure becomes a failed result without invoking the probe", async () => {
  const registry = newProbeRegistry()
  let invoked = false
  registry.register("live", "bad-parent", () => {
    invoked = true
  })
  const parent = {
    deadline() {
      throw new Error("deadline unavailable")
    },
    done: () => null,
    err: () => null,
    value: () => undefined
  }

  const report = await registry.check(parent, "live")
  expect(invoked).toBe(false)
  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error?.message).toBe("deadline unavailable")
})

test("Error.isError-recognized values are preserved by identity", async () => {
  const registry = newProbeRegistry()
  const error = new Error("preserved")
  registry.register("ready", "identity", async () => {
    throw error
  })

  const report = await registry.check(background(), "ready")
  expect(report.checks[0]?.error).toBe(error)
})

test("same-realm Error identity is preserved when the runtime lacks Error.isError", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  if (descriptor === undefined) throw new Error("Error.isError descriptor is missing")
  Object.defineProperty(Error, "isError", { ...descriptor, value: undefined })
  try {
    const registry = newProbeRegistry()
    const error = new Error("legacy runtime")
    registry.register("ready", "legacy", () => {
      throw error
    })

    const report = await registry.check(background(), "ready")

    expect(report.checks[0]?.error).toBe(error)
  } finally {
    Object.defineProperty(Error, "isError", descriptor)
  }
})

test("cross-realm synchronous Error throws are preserved by identity", async () => {
  const registry = newProbeRegistry()
  const crossRealm = vm.runInNewContext("new Error('cross realm sync')") as Error
  registry.register("ready", "cross", () => {
    throw crossRealm
  })

  const report = await registry.check(background(), "ready")
  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBe(crossRealm)
})

test("pre-canceled probes still preserve cross-realm synchronous Error without rejecting check", async () => {
  const registry = newProbeRegistry()
  const crossRealm = vm.runInNewContext("new Error('cross realm precancel')") as Error
  registry.register(
    "ready",
    "cross",
    () => {
      throw crossRealm
    },
    { timeoutMs: 0 }
  )

  await expect(registry.check(background(), "ready")).resolves.toMatchObject({
    ok: false,
    checks: [{ name: "cross", ok: false }]
  })
})

test("parent cancellation affects only the canceled probe result", async () => {
  const registry = newProbeRegistry()
  const parentCause = new Error("request aborted")
  const [parent, cancel] = withCancelCause(background())
  registry.register("ready", "wait", async (ctx) => {
    await new Promise<void>((resolve) =>
      ctx.done()?.addEventListener("abort", () => resolve(), { once: true })
    )
  })
  registry.register("ready", "fast", () => {})

  const inFlight = registry.check(parent, "ready")
  cancel(parentCause)

  const report = await inFlight
  expect(report.ok).toBe(false)
  expect(report.checks[0]?.error).toBe(parentCause)
  expect(report.checks[1]).toMatchObject({ ok: true, error: null })
})
