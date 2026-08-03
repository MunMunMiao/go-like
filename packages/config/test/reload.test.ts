import { describe, expect, test } from "bun:test"

import { background } from "@likego/context"
import type { ConfigSchema, ConfigSourceSnapshot, ConfigValue } from "../src/index"
import { newConfig, onReloadError, schema as configSchema, source } from "../src/index"
import { controlledWatcher, deferred, flush, startConfig, type Deferred } from "./helpers"

describe("background reload scheduler", () => {
  test("coalesces concurrent notifications and one dirty rerun without overlapping source loads", async () => {
    const nextCalls: Deferred<void>[] = []
    const done = deferred<void>()
    const watcher = controlledWatcher({ nextCalls, done, stops: [], name: "reload" })
    const reloads = [deferred<ConfigSourceSnapshot>(), deferred<ConfigSourceSnapshot>()]
    let loads = 0
    let active = 0
    let maximum = 0
    const config = newConfig(
      source({
        name: "reload",
        /** Returns immediate startup rounds followed by controlled background rounds. */
        async load() {
          loads += 1
          if (loads === 1) return { value: { loads }, revision: String(loads) }
          const pending = reloads[loads - 2]
          if (pending === undefined) throw new Error("unexpected reload")
          active += 1
          maximum = Math.max(maximum, active)
          try {
            return await pending.promise
          } finally {
            active -= 1
          }
        },
        /** Opens the controlled notification watcher. */
        async watch() {
          return watcher
        }
      })
    )
    const handle = await startConfig(config)
    nextCalls[0]?.resolve(undefined)
    await flush(8)
    expect(loads).toBe(2)
    nextCalls[1]?.resolve(undefined)
    await flush()
    nextCalls[2]?.resolve(undefined)
    await flush()
    expect(loads).toBe(2)
    reloads[0]?.resolve({ value: { loads: 2 }, revision: "2" })
    await flush(8)
    expect(loads).toBe(3)
    reloads[1]?.resolve({ value: { loads: 3 }, revision: "3" })
    await flush(8)
    expect(config.value("loads").load()).toBe(3)
    expect(maximum).toBe(1)
    await handle.close(background())
  })

  test("preserves last-good and retries one failed notification without a later event", async () => {
    const nextCalls: Deferred<void>[] = []
    const done = deferred<void>()
    const watcher = controlledWatcher({ nextCalls, done, stops: [], name: "recovery" })
    const failures: { error: Error; currentLoads: ConfigValue | null }[] = []
    let loads = 0
    const sourceFailure = new Error("reload failed")
    const config = newConfig(
      source({
        name: "recovery",
        /** Fails the first background round and succeeds without another source event. */
        async load() {
          loads += 1
          if (loads === 2) throw sourceFailure
          return { value: { loads }, revision: String(loads) }
        },
        /** Opens the controlled recovery watcher. */
        async watch() {
          return watcher
        }
      }),
      onReloadError(function report(error, current) {
        /** Records one last-good value for each recoverable round failure. */
        failures.push({
          error,
          currentLoads:
            current !== null &&
            typeof current === "object" &&
            "loads" in current &&
            typeof current.loads === "number"
              ? current.loads
              : null
        })
      })
    )
    const handle = await startConfig(config)
    const good = config.value("loads").load()
    nextCalls[0]?.resolve(undefined)
    await flush(10)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toMatchObject({ phase: "load", cause: sourceFailure })
    expect(failures[0]?.currentLoads).toBe(1)
    expect(config.value("loads").load()).toBe(good)

    for (let attempt = 0; attempt < 100 && loads < 3; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    expect(config.value("loads").load()).toBe(3)
    expect(failures).toHaveLength(1)
    await handle.close(background())
  })

  test("an event during a failed reload schedules exactly one recovery round", async () => {
    const nextCalls: Deferred<void>[] = []
    const done = deferred<void>()
    const watcher = controlledWatcher({ nextCalls, done, stops: [], name: "failure-dirty" })
    const round = deferred<ConfigSourceSnapshot>()
    let loads = 0
    let reports = 0
    const config = newConfig(
      source({
        name: "failure-dirty",
        /** Holds the first background round and succeeds on the coalesced rerun. */
        async load() {
          loads += 1
          if (loads === 2) return await round.promise
          return { value: { loads }, revision: String(loads) }
        },
        /** Opens the controlled watcher. */
        async watch() {
          return watcher
        }
      }),
      onReloadError(function report() {
        /** Counts background failure reports. */
        reports += 1
      })
    )
    const handle = await startConfig(config)
    nextCalls[0]?.resolve(undefined)
    await flush(8)
    nextCalls[1]?.resolve(undefined)
    await flush()
    round.reject(new Error("controlled failure"))
    await flush(12)
    expect(reports).toBe(1)
    expect(loads).toBe(3)
    expect(config.value("loads").load()).toBe(3)
    await handle.close(background())
  })

  test("observes throwing and rejecting reload hooks without stopping recovery", async () => {
    const nextCalls: Deferred<void>[] = []
    const done = deferred<void>()
    const watcher = controlledWatcher({ nextCalls, done, stops: [], name: "hook" })
    let loads = 0
    let hooks = 0
    const config = newConfig(
      source({
        name: "hook",
        /** Fails two background rounds before succeeding. */
        async load() {
          loads += 1
          if (loads === 2 || loads === 3) throw new Error("reload failure")
          return { value: { loads }, revision: String(loads) }
        },
        /** Opens the controlled hook watcher. */
        async watch() {
          return watcher
        }
      }),
      onReloadError(function report() {
        /** Alternates a thrown hook and a rejected thenable-like runtime return. */
        hooks += 1
        if (hooks === 1) throw new Error("hook threw")
        return Promise.reject(new Error("hook rejected"))
      })
    )
    const handle = await startConfig(config)
    nextCalls[0]?.resolve(undefined)
    await flush(10)
    nextCalls[1]?.resolve(undefined)
    await flush(10)
    nextCalls[2]?.resolve(undefined)
    await flush(10)
    expect(hooks).toBe(2)
    expect(config.value("loads").load()).toBe(4)
    await handle.close(background())
  })

  test("intentional stop cancels an in-flight background round, suppresses its hook, and waits late settlement", async () => {
    const nextCalls: Deferred<void>[] = []
    const done = deferred<void>()
    const watcher = controlledWatcher({ nextCalls, done, stops: [], name: "stop" })
    const late = deferred<ConfigSourceSnapshot>()
    let loads = 0
    let reports = 0
    const config = newConfig(
      source({
        name: "stop",
        /** Holds the first background source settlement across intentional stop. */
        async load() {
          loads += 1
          if (loads === 2) return await late.promise
          return { value: { loads }, revision: String(loads) }
        },
        /** Opens the controlled stop watcher. */
        async watch() {
          return watcher
        }
      }),
      onReloadError(function report() {
        /** Counts failures that must be suppressed for intentional cancellation. */
        reports += 1
      })
    )
    const handle = await startConfig(config)
    const good = config.value("loads").load()
    nextCalls[0]?.resolve(undefined)
    await flush(8)
    const stopping = handle.close(background())
    let settled = false
    /** Records whether the owner drain settled before hidden work. */
    function markSettled(): void {
      settled = true
    }
    void stopping.then(markSettled)
    await flush()
    expect(settled).toBe(false)
    late.resolve({ value: { stale: true }, revision: "late" })
    await stopping
    expect(reports).toBe(0)
    expect(config.value("loads").load()).toBe(good)
  })

  test("routes schema-bearing background failures through the captured typed error hook", async () => {
    const nextCalls: Deferred<void>[] = []
    const done = deferred<void>()
    const watcher = controlledWatcher({ nextCalls, done, stops: [], name: "schema-hook" })
    let loads = 0
    let hooks = 0
    const schema = {
      "~standard": {
        version: 1,
        vendor: "schema-hook",
        /** Produces a stable transformed output for successful rounds. */
        validate(_value: unknown) {
          return { value: { validated: true } }
        }
      }
    } satisfies ConfigSchema<{ readonly validated: boolean }>
    const config = newConfig(
      source({
        name: "schema-hook",
        /** Succeeds for startup and fails every background round. */
        async load() {
          loads += 1
          if (loads > 1) throw new Error("schema reload failed")
          return { value: {}, revision: String(loads) }
        },
        /** Opens the controlled schema-hook watcher. */
        async watch() {
          return watcher
        }
      }),
      configSchema(schema),
      onReloadError(function report() {
        /** Proves typed hooks are isolated in both success-return and throw forms. */
        hooks += 1
        if (hooks === 2) throw new Error("typed hook threw")
      })
    )
    const handle = await startConfig(config)
    nextCalls[0]?.resolve(undefined)
    await flush(8)
    nextCalls[1]?.resolve(undefined)
    await flush(8)
    expect(hooks).toBe(2)
    expect(config.value("validated").load()).toBe(true)
    await handle.close(background())
  })
})
