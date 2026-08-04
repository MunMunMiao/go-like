import { describe, expect, test } from "bun:test"

import { background, type Context } from "@go-like/context"

import type { Config, ConfigObject, ConfigSourceSnapshot, ConfigValue, Value } from "../src/index"
import { newConfig, source } from "../src/index"
import { controlledWatcher, deferred, flush, type Deferred } from "./helpers"

interface MutableConfig {
  readonly config: Config
  readonly change: () => Promise<void>
}

/** Creates one test source whose explicit changes use the same source-watcher path as providers. */
function mutableConfig(
  name: string,
  load: (ctx: Context) => Promise<ConfigSourceSnapshot>
): MutableConfig {
  const nextCalls: Deferred<void>[] = []
  const watcher = controlledWatcher({
    nextCalls,
    done: deferred<void>(),
    stops: [],
    name
  })
  let notification = 0
  const config = newConfig(
    source({
      name,
      load,
      async watch() {
        return watcher
      }
    })
  )
  return {
    config,
    async change() {
      while (nextCalls[notification] === undefined) await flush()
      nextCalls[notification]?.resolve(undefined)
      notification += 1
      await flush(12)
    }
  }
}

describe("Kratos-style config watchers", () => {
  test("observes only semantic changes after the current value is replaced", async () => {
    let document: ConfigObject = { service: { enabled: true, labels: { a: 1, b: 2 } } }
    const mutable = mutableConfig("watched", async function load() {
      return { value: document, revision: null }
    })
    const config = mutable.config
    await config.load(background())
    const view = config.value("service.labels")
    const calls: Array<{ key: string; value: Value }> = []
    config.watch("service.labels", function changed(key, value) {
      calls.push({ key, value })
    })

    document = { service: { enabled: false, labels: { b: 2, a: 1 } } }
    await mutable.change()
    expect(calls).toEqual([])

    document = { service: { enabled: false, labels: { a: 1, b: 3 } } }
    await mutable.change()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ key: "service.labels", value: view })
    expect(calls[0]?.value.load()).toEqual({ a: 1, b: 3 })
    await config.close(background())
  })

  test("replaces the prior observer when the same key is watched again", async () => {
    let count = 0
    const mutable = mutableConfig("replace", async function load() {
      count += 1
      return { value: { count }, revision: String(count) }
    })
    const config = mutable.config
    await config.load(background())
    const calls: string[] = []
    config.watch("count", function replaced() {
      calls.push("first")
    })
    config.watch("count", function current() {
      calls.push("second")
    })

    await mutable.change()
    expect(calls).toEqual(["second"])
    await config.close(background())
  })

  test("retains the last observed baseline while a key is absent", async () => {
    let document: ConfigObject = { feature: { release: 1 } }
    const mutable = mutableConfig("missing", async function load() {
      return { value: document, revision: null }
    })
    const config = mutable.config
    await config.load(background())
    const releases: ConfigValue[] = []
    config.watch("feature", function changed(_key, value) {
      const loaded = value.load()
      if (loaded !== null) releases.push(loaded)
    })

    document = {}
    await mutable.change()
    document = { feature: { release: 1 } }
    await mutable.change()
    document = { feature: { release: 2 } }
    await mutable.change()
    expect(releases).toEqual([{ release: 2 }])
    await config.close(background())
  })

  test("compares array values recursively while preserving order", async () => {
    let items: readonly ConfigValue[] = [1, { ready: true }]
    const mutable = mutableConfig("arrays", async function load() {
      return { value: { items }, revision: null }
    })
    const config = mutable.config
    await config.load(background())
    const seen: ConfigValue[] = []
    config.watch("items", function changed(_key, value) {
      const loaded = value.load()
      if (loaded !== null) seen.push(loaded)
    })

    items = [1, { ready: true }]
    await mutable.change()
    items = [1, { ready: false }]
    await mutable.change()
    expect(seen).toEqual([[1, { ready: false }]])
    await config.close(background())
  })

  test("isolates throwing and rejecting observers", async () => {
    let value = 1
    const mutable = mutableConfig("isolated", async function load() {
      return { value: { value }, revision: null }
    })
    const config = mutable.config
    await config.load(background())
    const calls: string[] = []
    config.watch("value", function throwing() {
      calls.push("throw")
      throw new Error("observer throw")
    })
    value = 2
    await mutable.change()
    expect(calls).toEqual(["throw"])

    config.watch("value", function rejecting() {
      calls.push("reject")
      return Promise.reject(new Error("observer reject"))
    })
    value = 3
    await mutable.change()
    expect(calls).toEqual(["throw", "reject"])
    await config.close(background())
  })

  test("rejects a missing key and invalid observer at registration", async () => {
    const config = newConfig(
      source({
        name: "validation",
        async load() {
          return { value: { ready: true }, revision: null }
        }
      })
    )
    expect(() => config.watch("ready", function changed() {})).toThrow("not found")
    await config.load(background())
    expect(() => config.watch("missing", function changed() {})).toThrow("not found")
    expect(() => config.watch("ready", JSON.parse("null"))).toThrow(TypeError)
    await config.close(background())
  })
})
