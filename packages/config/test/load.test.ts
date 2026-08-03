import { describe, expect, test } from "bun:test"

import { background, withCancelCause, type Context } from "@likego/context"
import type { ConfigSourceSnapshot } from "../src/index"
import { newConfig, source } from "../src/index"
import { deferred, flush } from "./helpers"

describe("initial config load", () => {
  test("loads once, publishes readiness, and rejects every repeated load state", async () => {
    const pending = deferred<ConfigSourceSnapshot>()
    let calls = 0
    const config = newConfig(
      source({
        name: "one-shot",
        load() {
          calls += 1
          return pending.promise
        }
      })
    )

    const loading = config.load(background())
    await flush()
    expect(calls).toBe(1)
    await expect(config.load(background())).rejects.toMatchObject({ status: "loading" })
    pending.resolve({ value: { ready: true }, revision: "one" })
    await loading
    expect(config.value("ready").load()).toBe(true)
    await expect(config.load(background())).rejects.toMatchObject({ status: "loaded" })
    await config.close(background())
    await expect(config.load(background())).rejects.toMatchObject({ status: "closed" })
  })

  test("rejects pre-cancellation before touching a source", async () => {
    const cancellation = new Error("caller canceled")
    const [ctx, cancel] = withCancelCause(background())
    cancel(cancellation)
    let calls = 0
    const config = newConfig(
      source({
        name: "untouched",
        async load() {
          calls += 1
          return { value: {}, revision: null }
        }
      })
    )

    await expect(config.load(ctx)).rejects.toBe(cancellation)
    expect(calls).toBe(0)
    expect(config.value("missing").load()).toBeNull()
    await expect(config.close(background())).rejects.toBe(cancellation)
  })

  test("returns a rejected Promise when initial Context inspection throws", async () => {
    const failure = new Error("Context inspection failed")
    const hostile: Context = {
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done() {
        return null
      },
      err(): null {
        throw failure
      },
      value() {
        return undefined
      }
    }
    let calls = 0
    const config = newConfig(
      source({
        name: "hostile-context",
        async load() {
          calls += 1
          return { value: {}, revision: null }
        }
      })
    )

    const loading = config.load(hostile)
    expect(loading).toBeInstanceOf(Promise)
    await expect(loading).rejects.toBe(failure)
    expect(calls).toBe(0)
    expect(config.value("missing").load()).toBeNull()
  })

  test("wraps asynchronous and synchronous source failures with their exact Error cause", async () => {
    const asynchronous = new Error("async source failed")
    const synchronous = new Error("sync source failed")
    const asyncConfig = newConfig(
      source({
        name: "async",
        async load() {
          throw asynchronous
        }
      })
    )
    const syncConfig = newConfig(
      source({
        name: "sync",
        load() {
          throw synchronous
        }
      })
    )

    await expect(asyncConfig.load(background())).rejects.toMatchObject({
      name: "ConfigSourceError",
      code: "LIKEGO_CONFIG_SOURCE",
      sourceName: "async",
      phase: "load",
      cause: asynchronous
    })
    await expect(syncConfig.load(background())).rejects.toMatchObject({
      phase: "load",
      cause: synchronous
    })
  })

  test("normalizes non-Error source rejection without retaining its value", async () => {
    const config = newConfig(
      source({
        name: "secret",
        load() {
          return Promise.reject({ token: "do-not-retain" })
        }
      })
    )
    const failure = await config.load(background()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: "ConfigSourceError", phase: "load" })
    expect(String(failure)).not.toContain("do-not-retain")
    expect(JSON.stringify(failure)).not.toContain("do-not-retain")
  })
})
